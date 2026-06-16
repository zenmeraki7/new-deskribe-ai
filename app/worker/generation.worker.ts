import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { sanitizeAiOutput } from "../contracts/seoFields.server";
import { generateProductDescription } from "../lib/ai.server";
import { reconcileBulkOperationStatus } from "../lib/bulkOperation.server";
import { refundCredits } from "../lib/creditService.server";
import { db } from "../lib/db.server";
import {
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RETRY_BASE_DELAY_MS,
} from "../lib/generationJobStates";
import { sanitiseHtml } from "../lib/html.server";
import { computeProductHash } from "../lib/productHash.server";
import { getRedis } from "../lib/redis.server";
import {
  adminGraphqlWithRetry,
  type AdminGraphql,
} from "../lib/shopifyGraphql.server";
import { unauthenticated } from "../shopify.server";

const DraftSchema = z
  .object({
    body_html: z.string().min(1),
    meta_title: z.string().optional(),
    meta_description: z.string().optional(),
    keywords: z.array(z.string().min(1)).max(80).optional(),
    primary_keyword: z.string().optional(),
    headline: z.string().optional(),
    social_caption: z.string().optional(),
  })
  .strict();

type DraftResult = z.infer<typeof DraftSchema>;

type GenerationJobData = {
  traceId?: string;
  jobId: string;
  bulkId?: string;
  shopDomain: string;
  productId: string;
  vibe?: string;
  format?: string;
  keywords?: string;
  creditRequestId?: string;
  creditCost?: number;
};

const LIMITS = {
  CONCURRENCY: 2,
  MAX_ERROR_CHARS: 2_000,
  LOCK_STALE_MS: 30 * 60 * 1000,
} as const;

const WORKER_ID = `${process.env.HOSTNAME ?? "generation-worker"}:${process.pid}`;

function clampError(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message.length <= LIMITS.MAX_ERROR_CHARS
    ? message
    : message.slice(0, LIMITS.MAX_ERROR_CHARS);
}

function classifyError(error: unknown) {
  if (error instanceof z.ZodError) return "INVALID_AI_OUTPUT";

  const message = clampError(error).toLowerCase();
  if (message.includes("not found") || message.includes("access denied")) {
    return "PRODUCT_UNAVAILABLE";
  }
  if (message.includes("throttle") || message.includes("429")) {
    return "UPSTREAM_RATE_LIMIT";
  }
  if (message.includes("timeout")) return "UPSTREAM_TIMEOUT";
  return "GENERATION_FAILED";
}

function retryDelayMs(attemptsUsed: number) {
  return Math.min(
    GENERATION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptsUsed - 1),
    60_000,
  );
}

async function setProgressSafe(
  jobId: string,
  shopDomain: string,
  progress: number,
) {
  await db.generationJob.updateMany({
    where: {
      id: jobId,
      shopDomain,
      status: "PROCESSING",
      lockedBy: WORKER_ID,
      progress: { lt: progress },
    },
    data: { progress, lockedAt: new Date() },
  });
}

async function markCancelled(
  jobId: string,
  shopDomain: string,
  bulkId?: string | null,
) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: {
      status: "CANCELLED",
      cancelRequested: true,
      cancelledAt: new Date(),
      completedAt: new Date(),
      progress: 0,
      lockedAt: null,
      lockedBy: null,
    },
  });
  await reconcileBulkOperationStatus({ bulkId, shopDomain });
}

async function fetchProductMeta(adminGraphql: AdminGraphql, productId: string) {
  const response = await adminGraphqlWithRetry<{
    data?: {
      product?: {
        id: string;
        title: string;
        vendor: string;
        productType: string;
        tags: string[];
        handle: string;
        descriptionHtml: string;
        seo: {
          title: string | null;
          description: string | null;
        } | null;
      } | null;
    };
  }>(
    adminGraphql,
    `#graphql
    query WorkerProductMeta($id: ID!) {
      product(id: $id) {
        id
        title
        vendor
        productType
        tags
        handle
        descriptionHtml
        seo {
          title
          description
        }
      }
    }`,
    { id: productId },
  );

  const product = response.data?.product;
  return product?.id === productId ? product : null;
}

async function refundFinalFailure({
  creditRequestId,
  creditCost,
  shopDomain,
  jobId,
  productId,
}: {
  creditRequestId: string | null;
  creditCost: unknown;
  shopDomain: string;
  jobId: string;
  productId: string;
}) {
  if (!creditRequestId || creditCost == null) return;

  try {
    await refundCredits({
      shopId: shopDomain,
      amount: Number(creditCost),
      requestId: `${creditRequestId}:${jobId}:generation-failed`,
      metadata: {
        intent: "generation_worker",
        jobId,
        productId,
        creditRequestId,
      },
    });
  } catch (error) {
    console.error("[generation.worker] final failure refund failed", {
      jobId,
      shopDomain,
      message: clampError(error),
    });
  }
}

let generationWorker: Worker<GenerationJobData> | null = null;

export function startGenerationWorker() {
  if (generationWorker) return generationWorker;

  generationWorker = new Worker<GenerationJobData>(
    "generation",
    async (bullJob: Job<GenerationJobData>) => {
      const { jobId, shopDomain, productId } = bullJob.data;

      if (!jobId || !shopDomain || !productId) {
        throw new Error(
          "Invalid job payload (missing jobId/shopDomain/productId)",
        );
      }

      const dbJob = await db.generationJob.findFirst({
        where: { id: jobId, shopDomain },
        select: {
          status: true,
          bulkId: true,
          productId: true,
          keywords: true,
          vibe: true,
          format: true,
          customInstruction: true,
          creditRequestId: true,
          creditCost: true,
          cancelRequested: true,
          attempts: true,
          maxAttempts: true,
          lockedAt: true,
          bulk: {
            select: {
              status: true,
            },
          },
        },
      });

      if (!dbJob) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (dbJob.status === "COMPLETED") {
        return { ok: true, already: "COMPLETED" as const };
      }
      if (dbJob.status === "CANCELLED") {
        return { ok: true, already: "CANCELLED" as const };
      }
      if (dbJob.status === "FAILED") {
        return { ok: true, already: "FAILED" as const };
      }
      if (
        dbJob.bulk?.status === "CANCELLED" ||
        dbJob.bulk?.status === "CANCELLING"
      ) {
        await markCancelled(jobId, shopDomain, dbJob.bulkId);
        return { ok: true, already: "CANCELLED" as const };
      }
      if (dbJob.cancelRequested) {
        await markCancelled(jobId, shopDomain, dbJob.bulkId);
        return { ok: true, already: "CANCELLED" as const };
      }

      const staleLockBefore = new Date(Date.now() - LIMITS.LOCK_STALE_MS);
      const canRecoverStaleProcessing =
        dbJob.status === "PROCESSING" &&
        dbJob.lockedAt !== null &&
        dbJob.lockedAt <= staleLockBefore;

      if (dbJob.status !== "PENDING" && !canRecoverStaleProcessing) {
        return { ok: true, already: dbJob.status };
      }

      const claimedAt = new Date();
      const claimed = await db.generationJob.updateMany({
        where: {
          id: jobId,
          shopDomain,
          OR: [
            { status: "PENDING" },
            {
              status: "PROCESSING",
              lockedAt: { lte: staleLockBefore },
            },
          ],
        },
        data: {
          status: "PROCESSING",
          attempts: { increment: 1 },
          lockedAt: claimedAt,
          lockedBy: WORKER_ID,
          nextRunAt: claimedAt,
          progress: 1,
          errorMessage: null,
        },
      });

      if (claimed.count !== 1) {
        return { ok: true, already: "CLAIMED_BY_OTHER" as const };
      }

      try {
        await setProgressSafe(jobId, shopDomain, 10);

        const keywordsList = (dbJob.keywords ?? "")
          .split(",")
          .map((keyword) => keyword.trim())
          .filter(Boolean);

        await setProgressSafe(jobId, shopDomain, 20);

        const { admin } = await unauthenticated.admin(shopDomain);
        const productMeta = await fetchProductMeta(admin.graphql, productId);
        if (!productMeta) {
          throw new Error("Product not found or access denied.");
        }
        const sourceHash = computeProductHash({
          title: productMeta.title ?? "",
          handle: productMeta.handle ?? "",
          descriptionHtml: productMeta.descriptionHtml ?? "",
          tags: Array.isArray(productMeta.tags) ? productMeta.tags : [],
          seoTitle: productMeta.seo?.title ?? "",
          seoDescription: productMeta.seo?.description ?? "",
        });

        await db.generationJob.updateMany({
          where: {
            id: jobId,
            shopDomain,
            status: "PROCESSING",
            lockedBy: WORKER_ID,
          },
          data: {
            productTitle: productMeta.title,
            productVendor: productMeta.vendor ?? "",
            productType: productMeta.productType ?? "",
            productTags: Array.isArray(productMeta.tags)
              ? productMeta.tags.join(",")
              : "",
            lockedAt: new Date(),
          },
        });

        const aiResult = await generateProductDescription({
          title: productMeta.title,
          vendor: productMeta.vendor ?? "",
          productType: productMeta.productType ?? "",
          tags: Array.isArray(productMeta.tags) ? productMeta.tags : [],
          vibe: dbJob.vibe ?? "casual",
          format: dbJob.format ?? "paragraph",
          keywords: keywordsList,
          customInstruction: dbJob.customInstruction ?? undefined,
        });

        await setProgressSafe(jobId, shopDomain, 80);

        const cancelCheck = await db.generationJob.findFirst({
          where: { id: jobId, shopDomain },
          select: { cancelRequested: true, status: true },
        });
        if (
          cancelCheck?.cancelRequested ||
          cancelCheck?.status === "CANCELLED"
        ) {
          await markCancelled(jobId, shopDomain, dbJob.bulkId);
          return { ok: true, cancelled: true as const };
        }

        const wordCount = aiResult.body_html
          .replace(/<[^>]+>/g, " ")
          .trim()
          .split(/\s+/).length;
        const draft: DraftResult = DraftSchema.parse({
          body_html: sanitiseHtml(aiResult.body_html),
          meta_title: aiResult.meta_title,
          meta_description: aiResult.meta_description,
          keywords: aiResult.keywords,
          primary_keyword: aiResult.keywords?.[0] ?? undefined,
          headline: `${productMeta.title} - ${dbJob.vibe ?? "casual"}`,
          social_caption: aiResult.social_caption || undefined,
        });
        const sanitized = sanitizeAiOutput({
          shopId: shopDomain,
          productId,
          fields: {
            descriptionHtml: draft.body_html,
            seoTitle: draft.meta_title,
            seoDescription: draft.meta_description,
          },
        });

        const completed = await db.$transaction(async (tx) => {
          const update = await tx.generationJob.updateMany({
            where: {
              id: jobId,
              shopDomain,
              status: "PROCESSING",
              lockedBy: WORKER_ID,
              cancelRequested: false,
            },
            data: {
              status: "COMPLETED",
              result: draft,
              progress: 100,
              errorMessage: null,
              lastErrorCode: null,
              lastError: null,
              completedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              costTokens: wordCount,
            },
          });

          if (update.count !== 1) return false;

          await tx.generatedSeoOutput.upsert({
            where: {
              shopDomain_jobId_productId: {
                shopDomain,
                jobId,
                productId,
              },
            },
            create: {
              shopDomain,
              jobId,
              productId,
              fields: sanitized.fields as any,
              warnings: sanitized.warnings as any,
              sourceHash,
              status: "READY",
              appliedAt: null,
              appliedBy: null,
              applyId: null,
            },
            update: {
              fields: sanitized.fields as any,
              warnings: sanitized.warnings as any,
              sourceHash,
              status: "READY",
              appliedAt: null,
              appliedBy: null,
              applyId: null,
            },
          });

          return true;
        });

        if (!completed) {
          const state = await db.generationJob.findFirst({
            where: { id: jobId, shopDomain },
            select: { cancelRequested: true, status: true },
          });
          if (state?.cancelRequested || state?.status === "CANCELLED") {
            await markCancelled(jobId, shopDomain, dbJob.bulkId);
            return { ok: true, cancelled: true as const };
          }

          throw new Error("Generation job claim lost before completion");
        }

        await reconcileBulkOperationStatus({
          bulkId: dbJob.bulkId,
          shopDomain,
        });

        return { ok: true };
      } catch (error) {
        const message = clampError(error);
        const code = classifyError(error);
        const attemptsUsed = dbJob.attempts + 1;
        const queueMaxAttempts = Number(
          bullJob.opts.attempts ?? GENERATION_MAX_ATTEMPTS,
        );
        const maxAttempts = Math.max(
          1,
          Math.min(dbJob.maxAttempts, queueMaxAttempts),
        );
        const willRetry = attemptsUsed < maxAttempts;

        if (willRetry) {
          await db.generationJob.updateMany({
            where: {
              id: jobId,
              shopDomain,
              status: "PROCESSING",
              lockedBy: WORKER_ID,
            },
            data: {
              status: "PENDING",
              progress: 0,
              errorMessage: message,
              lastErrorCode: code,
              lastError: message,
              completedAt: null,
              nextRunAt: new Date(Date.now() + retryDelayMs(attemptsUsed)),
              lockedAt: null,
              lockedBy: null,
            },
          });
          await reconcileBulkOperationStatus({
            bulkId: dbJob.bulkId,
            shopDomain,
          });
        } else {
          await db.generationJob.updateMany({
            where: { id: jobId, shopDomain },
            data: {
              status: "FAILED",
              progress: 0,
              errorMessage: message,
              lastErrorCode: code,
              lastError: message,
              completedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
            },
          });
          await reconcileBulkOperationStatus({
            bulkId: dbJob.bulkId,
            shopDomain,
          });
          await refundFinalFailure({
            creditRequestId: dbJob.creditRequestId,
            creditCost: dbJob.creditCost,
            shopDomain,
            jobId,
            productId,
          });
        }

        throw error;
      }
    },
    {
      connection: getRedis() as any,
      concurrency: LIMITS.CONCURRENCY,
    },
  );

  generationWorker.on("ready", () => {
    console.log("[generation.worker] ready - using real AI generation");
  });

  generationWorker.on("failed", (job, error) => {
    console.error("[generation.worker] attempt failed", {
      bullJobId: job?.id,
      jobId: job?.data?.jobId,
      shopDomain: job?.data?.shopDomain,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
      message: error?.message,
    });
  });

  generationWorker.on("error", (error) => {
    console.error("[generation.worker] error", error);
  });

  return generationWorker;
}
