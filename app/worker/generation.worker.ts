// FILE: app/workers/generation.worker.ts
import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { db } from "../lib/db.server";
import { getRedis  } from "../lib/redis.server";
import { sanitiseHtml } from "../lib/html.server";
import { generateProductDescription } from "../lib/ai.server";
import { refundCredits } from "../lib/creditService.server";
import { appLog, durationSince } from "../utils/observability.server";
import { GENERATION_JOB_ATTEMPTS } from "../lib/queue.server";


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
};

const LIMITS = {
  CONCURRENCY: 4,
  MAX_ERROR_CHARS: 2_000,
} as const;

function clampError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
  return msg.length <= LIMITS.MAX_ERROR_CHARS ? msg : msg.slice(0, LIMITS.MAX_ERROR_CHARS);
}

async function setProgressSafe(jobId: string, shopDomain: string, progress: number) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain, progress: { lt: progress } },
    data: { progress },
  });
}

async function markFailed(jobId: string, shopDomain: string, errorMessage: string) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: { status: "FAILED", errorMessage, progress: 0 },
  });
}

async function markCompleted(jobId: string, shopDomain: string, result: DraftResult, costTokens = 0) {
  await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: { status: "COMPLETED", result, progress: 100, errorMessage: null, costTokens },
  });
}

let generationWorker: Worker<GenerationJobData> | null = null;

export function startGenerationWorker() {
  if (generationWorker) return generationWorker;

  generationWorker = new Worker<GenerationJobData>(
  "generation",
  async (bullJob: Job<GenerationJobData>) => {
    const startedAt = Date.now();
    const { jobId, shopDomain, productId, bulkId, traceId } =
      bullJob.data || ({} as any);

    if (!jobId || !shopDomain || !productId) {
      appLog.error("Generation worker received invalid payload", {
        operation: "generation.worker",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: traceId,
        productId,
        status: "invalid_payload",
      });
      throw new Error("Invalid job payload (missing jobId/shopDomain/productId)");
    }

    const dbJob = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain },
      select: {
        id: true,
        status: true,
        productId: true,
        productTitle: true,
  productVendor: true,   // new
  productType: true,     // new
  productTags: true,     // new
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
      appLog.warn("Generation worker could not find DB job", {
        operation: "generation.worker",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: traceId,
        productId,
        durationMs: durationSince(startedAt),
        status: "job_not_found",
      });
      return { ok: false, code: "JOB_NOT_FOUND" as const };
    }

    if (dbJob.status === "COMPLETED") return { ok: true, already: "COMPLETED" as const };
    if (dbJob.status === "CANCELLED") return { ok: true, already: "CANCELLED" as const };
    if (dbJob.status === "FAILED") return { ok: true, already: "FAILED" as const };
    if (dbJob.status !== "PENDING" && dbJob.status !== "PROCESSING") {
      return { ok: true, already: dbJob.status };
    }

    // Claim: PENDING → PROCESSING
    const claimed = await db.generationJob.updateMany({
      where: { id: jobId, shopDomain, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "PROCESSING", progress: 1, errorMessage: null },
    });

    if (claimed.count !== 1) {
      appLog.info("Generation worker claim skipped", {
        operation: "generation.worker.claim",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: dbJob.creditRequestId ?? traceId,
        productId,
        durationMs: durationSince(startedAt),
        status: "claimed_by_other",
      });
      return { ok: true, already: "CLAIMED_BY_OTHER" as const };
    }

    try {
      appLog.info("Generation worker started", {
        operation: "generation.worker",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: dbJob.creditRequestId ?? traceId,
        productId,
        status: "started",
      });
      await setProgressSafe(jobId, shopDomain, 10);

      // ── Parse keywords CSV ──────────────────────────────────────────────
      const keywordsList = (dbJob.keywords ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      await setProgressSafe(jobId, shopDomain, 20);

      // ── Fetch full product meta from DB job (title stored at enqueue time) ──
      // We need vendor/productType/tags for the AI prompt.
      // These aren't stored in the job, so we fetch from Shopify via a lightweight
      // approach: use what we have (title) and fallback gracefully.
      // NOTE: For richer output, store vendor/productType/tags at enqueue time.
      const title = dbJob.productTitle ?? dbJob.productId;

      // ── Call real AI ────────────────────────────────────────────────────
      const aiResult = await generateProductDescription({
  title: dbJob.productTitle ?? dbJob.productId,
  vendor: dbJob.productVendor ?? "",
  productType: dbJob.productType ?? "",
  tags: dbJob.productTags ? dbJob.productTags.split(",").map(t => t.trim()).filter(Boolean) : [],
  vibe: dbJob.vibe ?? "casual",
  format: dbJob.format ?? "paragraph",
  keywords: keywordsList,
  includeSocials: dbJob.includeSocials ?? false,
  customInstruction: dbJob.customInstruction ?? undefined,
});

      await setProgressSafe(jobId, shopDomain, 80);

      // ── Shape result ────────────────────────────────────────────────────
      const wordCount = aiResult.body_html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
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

      appLog.info("Generation worker completed", {
        operation: "generation.worker",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: dbJob.creditRequestId ?? traceId,
        productId,
        durationMs: durationSince(startedAt),
        status: "completed",
        wordCount,
      });

      return { ok: true };
    } catch (err) {
      const msg = clampError(err);
      const maxAttempts = bullJob.opts.attempts ?? GENERATION_JOB_ATTEMPTS;
      const attemptNumber = bullJob.attemptsMade + 1;
      const isFinalAttempt = attemptNumber >= maxAttempts;

      if (!isFinalAttempt) {
        await db.generationJob.updateMany({
          where: { id: jobId, shopDomain, status: "PROCESSING" },
          data: {
            status: "PENDING",
            progress: 0,
            errorMessage: `Attempt ${attemptNumber}/${maxAttempts} failed: ${msg}`,
          },
        });
        appLog.warn("Generation worker attempt failed; retry scheduled", {
          operation: "generation.worker",
          shop: shopDomain,
          jobId,
          bulkId,
          requestId: dbJob.creditRequestId ?? traceId,
          productId,
          durationMs: durationSince(startedAt),
          status: "retry_scheduled",
          attempt: attemptNumber,
          maxAttempts,
          error: err,
        });
        throw err;
      }

      await markFailed(jobId, shopDomain, msg);
      if (dbJob.creditRequestId && dbJob.creditCost) {
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
      }
      appLog.error("Generation worker failed", {
        operation: "generation.worker",
        shop: shopDomain,
        jobId,
        bulkId,
        requestId: dbJob.creditRequestId ?? traceId,
        productId,
        durationMs: durationSince(startedAt),
        status: "failed",
        attempt: attemptNumber,
        maxAttempts,
        error: err,
      });
      throw err;
    }
  },
  {
    connection: getRedis() as any,
    concurrency: LIMITS.CONCURRENCY,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

generationWorker.on("ready", () => {
  console.log("[generation.worker] ready — using real AI generation");
});

generationWorker.on("failed", (job, err) => {
  appLog.error("BullMQ generation job failed", {
    operation: "generation.worker.bullmq_failed",
    jobId: job?.data?.jobId,
    shop: job?.data?.shopDomain,
    bulkId: job?.data?.bulkId,
    requestId: job?.data?.creditRequestId ?? job?.data?.traceId,
    productId: job?.data?.productId,
    bullJobId: job?.id,
    status: "failed",
    error: err,
  });
  console.error("[generation.worker] failed", {
    bullJobId: job?.id,
    jobId: job?.data?.jobId,
    shopDomain: job?.data?.shopDomain,
    message: err?.message,
  });
});

generationWorker.on("error", (err) => {
  appLog.error("Generation worker runtime error", {
    operation: "generation.worker.error",
    status: "failed",
    error: err,
  });
  console.error("[generation.worker] error", err);
});

  return generationWorker;
}
