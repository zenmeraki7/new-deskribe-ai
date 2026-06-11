// FILE: app/workers/generation.worker.ts
import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { db } from "../lib/db.server.ts";
import { getRedis  } from "../lib/redis.server.ts";
import { sanitiseHtml } from "../lib/html.server.ts";
import { generateProductDescription } from "../lib/ai.server.ts";
import { refundCredits } from "../lib/creditService.server.ts";

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
  const updated = await db.generationJob.updateMany({
    where: { id: jobId, shopDomain, progress: { lt: progress } },
    data: { progress },
  });
  console.log("[bullmq-audit][worker] progress update", {
    generationJobId: jobId,
    shopDomain,
    progress,
    updatedCount: updated.count,
  });
}

async function markFailed(jobId: string, shopDomain: string, errorMessage: string) {
  const updated = await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: { status: "FAILED", errorMessage, progress: 0 },
  });
  console.log("[bullmq-audit][worker] status FAILED update", {
    generationJobId: jobId,
    shopDomain,
    updatedCount: updated.count,
    errorMessage,
  });
}

async function markCompleted(jobId: string, shopDomain: string, result: DraftResult, costTokens = 0) {
  const updated = await db.generationJob.updateMany({
    where: { id: jobId, shopDomain },
    data: { status: "COMPLETED", result, progress: 100, errorMessage: null, costTokens },
  });
  console.log("[bullmq-audit][worker] status COMPLETED update", {
    generationJobId: jobId,
    shopDomain,
    updatedCount: updated.count,
  });
}

console.log("[bullmq-audit][worker] defining worker", {
  workerQueueName: "generation",
  redisUrlPresent: Boolean(process.env.REDIS_URL),
  concurrency: LIMITS.CONCURRENCY,
});

export const generationWorker = new Worker<GenerationJobData>(
  "generation",
  async (bullJob: Job<GenerationJobData>) => {
    const { jobId, shopDomain, productId } = bullJob.data || ({} as any);

    console.log("[bullmq-audit][worker] processor received job", {
      workerQueueName: bullJob.queueName,
      bullJobId: bullJob.id,
      jobName: bullJob.name,
      payload: bullJob.data,
    });

    if (!jobId || !shopDomain || !productId) {
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

    console.log("[bullmq-audit][worker] GenerationJob lookup", {
      generationJobId: jobId,
      shopDomain,
      found: Boolean(dbJob),
      status: dbJob?.status,
    });

    if (!dbJob) return { ok: false, code: "JOB_NOT_FOUND" as const };

    if (dbJob.status === "COMPLETED") return { ok: true, already: "COMPLETED" as const };
    if (dbJob.status === "CANCELLED") return { ok: true, already: "CANCELLED" as const };
    if (dbJob.status === "FAILED") return { ok: true, already: "FAILED" as const };
    if (dbJob.status !== "PENDING") return { ok: true, already: dbJob.status  };

    // Claim: PENDING → PROCESSING
    const claimed = await db.generationJob.updateMany({
      where: { id: jobId, shopDomain, status: "PENDING" },
      data: { status: "PROCESSING", progress: 1, errorMessage: null },
    });

    console.log("[bullmq-audit][worker] status PROCESSING update", {
      generationJobId: jobId,
      shopDomain,
      updatedCount: claimed.count,
    });

    if (claimed.count !== 1) {
      return { ok: true, already: "CLAIMED_BY_OTHER" as const };
    }

    try {
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
      console.log("[bullmq-audit][worker] generateProductDescription start", {
        generationJobId: jobId,
        shopDomain,
        productId,
      });

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

      console.log("[bullmq-audit][worker] generateProductDescription finish", {
        generationJobId: jobId,
        shopDomain,
        productId,
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

      return { ok: true };
    } catch (err) {
      const msg = clampError(err);
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
      throw err;
    }
  },
  {
    connection: getRedis (),
    concurrency: LIMITS.CONCURRENCY,
  },
);

generationWorker.on("ready", () => {
  console.log("[generation.worker] ready — using real AI generation");
});

generationWorker.on("active", (job) => {
  console.log("[bullmq-audit][worker] active", {
    workerQueueName: job.queueName,
    bullJobId: job.id,
    jobName: job.name,
    generationJobId: job.data?.jobId,
  });
});

generationWorker.on("completed", (job, result) => {
  console.log("[bullmq-audit][worker] completed event", {
    workerQueueName: job.queueName,
    bullJobId: job.id,
    generationJobId: job.data?.jobId,
    result,
  });
});

generationWorker.on("failed", (job, err) => {
  console.error("[bullmq-audit][worker] failed event", {
    workerQueueName: job?.queueName,
    bullJobId: job?.id,
    generationJobId: job?.data?.jobId,
    message: err?.message,
  });
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
