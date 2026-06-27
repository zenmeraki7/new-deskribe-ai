// FILE: app/workers/generation.worker.ts
//
// FIX 1: BullMQ jobId format unified to `${shopDomain}:${job.id}` everywhere.
//         Previously enqueue.server.ts used bare `job.id` as the BullMQ jobId
//         while jobs.server.ts used `${shopDomain}:${job.id}`, causing BullMQ
//         to silently discard duplicates or miss jobs entirely.
//
// FIX 2: refundCredits no longer crashes the worker on the failure path.
//         The call is fully wrapped in try/catch so a refund failure never
//         prevents the job from being marked FAILED in the DB.

import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { db } from "../lib/db.server";
import { getRedis } from "../lib/redis.server";
import { sanitiseHtml } from "../lib/html.server";
import { generateProductDescription } from "../lib/ai.server";
import { refundCredits } from "../lib/creditService.server";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

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
  includeSocials?: boolean;
  creditRequestId?: string;
  creditCost?: number;
  customInstruction?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LIMITS = {
  CONCURRENCY: 4,
  MAX_ERROR_CHARS: 2_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clampError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
  return msg.length <= LIMITS.MAX_ERROR_CHARS
    ? msg
    : msg.slice(0, LIMITS.MAX_ERROR_CHARS);
}

async function setProgressSafe(
  jobId: string,
  shopDomain: string,
  progress: number,
) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain, progress: { lt: progress } },
    data: { progress },
  });
}

async function markFailed(
  jobId: string,
  shopDomain: string,
  errorMessage: string,
) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: { status: "FAILED", errorMessage, progress: 0 },
  });
}

async function markCompleted(
  jobId: string,
  shopDomain: string,
  result: DraftResult,
  costTokens = 0,
) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: {
      status: "COMPLETED",
      result,
      progress: 100,
      errorMessage: null,
      costTokens,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker singleton
// ─────────────────────────────────────────────────────────────────────────────

let generationWorker: Worker<GenerationJobData> | null = null;

export function startGenerationWorker() {
  if (generationWorker) return generationWorker;

  generationWorker = new Worker<GenerationJobData>(
    "generation",
    async (bullJob: Job<GenerationJobData>) => {
      const { jobId, shopDomain, productId } = bullJob.data || ({} as any);

      if (!jobId || !shopDomain || !productId) {
        throw new Error(
          "Invalid job payload (missing jobId/shopDomain/productId)",
        );
      }

      console.log(`[worker] picked up job ${jobId} for ${shopDomain}`);

      const dbJob = await db.generationJob.findFirst({
        where: { id: jobId, shopDomain },
        select: {
          id: true,
          status: true,
          productId: true,
          productTitle: true,
          productVendor: true,
          productType: true,
          productTags: true,
          keywords: true,
          vibe: true,
          format: true,
          includeSocials: true,
          customInstruction: true,
          creditRequestId: true,
          creditCost: true,
        },
      });

      if (!dbJob) {
        console.warn(`[worker] job ${jobId} not found in DB — skipping`);
        return { ok: false, code: "JOB_NOT_FOUND" as const };
      }

      if (dbJob.status === "COMPLETED")
        return { ok: true, already: "COMPLETED" as const };
      if (dbJob.status === "CANCELLED")
        return { ok: true, already: "CANCELLED" as const };
      if (dbJob.status === "FAILED")
        return { ok: true, already: "FAILED" as const };
      if (dbJob.status !== "PENDING")
        return { ok: true, already: dbJob.status };

      // Claim: PENDING → PROCESSING (optimistic concurrency guard)
      const claimed = await db.generationJob.updateMany({
        where: { id: jobId, shopDomain, status: "PENDING" },
        data: { status: "PROCESSING", progress: 1, errorMessage: null },
      });

      if (claimed.count !== 1) {
        console.warn(`[worker] job ${jobId} already claimed by another worker`);
        return { ok: true, already: "CLAIMED_BY_OTHER" as const };
      }

      try {
        await setProgressSafe(jobId, shopDomain, 10);

        const keywordsList = (dbJob.keywords ?? "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);

        await setProgressSafe(jobId, shopDomain, 20);

        const title = dbJob.productTitle ?? dbJob.productId;

        const aiResult = await generateProductDescription({
          title,
          vendor: dbJob.productVendor ?? "",
          productType: dbJob.productType ?? "",
          tags: dbJob.productTags
            ? dbJob.productTags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          vibe: dbJob.vibe ?? "casual",
          format: dbJob.format ?? "paragraph",
          keywords: keywordsList,
          includeSocials: dbJob.includeSocials ?? false,
          customInstruction: dbJob.customInstruction ?? undefined,
        });

        await setProgressSafe(jobId, shopDomain, 80);

        const wordCount = aiResult.body_html
          .replace(/<[^>]+>/g, " ")
          .trim()
          .split(/\s+/).length;

        const sanitizedHtml = sanitiseHtml(aiResult.body_html);

        const draft: DraftResult = DraftSchema.parse({
          body_html: sanitizedHtml,
          meta_title: aiResult.meta_title,
          meta_description: aiResult.meta_description,
          keywords: aiResult.keywords,
          primary_keyword: aiResult.keywords?.[0] ?? undefined,
          headline: `${title} — ${dbJob.vibe ?? "casual"}`,
          social_caption: aiResult.social_caption || undefined,
        });

        await markCompleted(jobId, shopDomain, draft, wordCount);
        console.log(`[worker] job ${jobId} COMPLETED`);

        return { ok: true };
      } catch (err) {
        const msg = clampError(err);
        console.error(`[worker] job ${jobId} FAILED:`, msg);

        await markFailed(jobId, shopDomain, msg);

        // FIX 2: refundCredits wrapped in try/catch — a refund failure must
        // never prevent the job from being marked FAILED or crash the worker.
        if (dbJob.creditRequestId && dbJob.creditCost) {
          try {
            await refundCredits({
              shopId: shopDomain,
              amount: Number(dbJob.creditCost),
              requestId: `${dbJob.creditRequestId}:${jobId}:generation-failed`,
              metadata: {
                intent: "generation_worker",
                jobId,
                productId,
                creditRequestId: dbJob.creditRequestId,
              },
            });
          } catch (refundErr) {
            // Log but swallow — refund failure is not fatal for the worker
            console.error(
              `[worker] refund failed for job ${jobId}:`,
              refundErr,
            );
          }
        }

        throw err; // rethrow so BullMQ marks the bull job as failed too
      }
    },
    {
      connection: getRedis(),
      concurrency: LIMITS.CONCURRENCY,
    },
  );

  generationWorker.on("ready", () => {
    console.log("[generation.worker] ready — listening for jobs");
  });

  generationWorker.on("completed", (job) => {
    console.log(`[generation.worker] completed bullJobId=${job.id} jobId=${job.data?.jobId}`);
  });

  generationWorker.on("failed", (job, err) => {
    console.error("[generation.worker] failed", {
      bullJobId: job?.id,
      jobId: job?.data?.jobId,
      shopDomain: job?.data?.shopDomain,
      message: err?.message,
    });
  });

  generationWorker.on("error", (err) => {
    console.error("[generation.worker] error", err);
  });

  return generationWorker;
}