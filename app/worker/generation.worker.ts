// FILE: app/workers/generation.worker.ts
import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { db } from "../lib/db.server";
import { redisConnection } from "../lib/queue.server";
import { sanitiseHtml } from "../lib/html.server";
import { generateProductDescription } from "../lib/ai.server";

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

export const generationWorker = new Worker<GenerationJobData>(
  "generation",
  async (bullJob: Job<GenerationJobData>) => {
    const { jobId, shopDomain, productId } = bullJob.data || ({} as any);

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
      },
    });

    if (!dbJob) return { ok: false, code: "JOB_NOT_FOUND" as const };

    if (dbJob.status === "COMPLETED") return { ok: true, already: "COMPLETED" as const };
    if (dbJob.status === "CANCELLED") return { ok: true, already: "CANCELLED" as const };
    if (dbJob.status === "FAILED") return { ok: true, already: "FAILED" as const };
    if (dbJob.status !== "PENDING") return { ok: true, already: dbJob.status as const };

    // Claim: PENDING → PROCESSING
    const claimed = await db.generationJob.updateMany({
      where: { id: jobId, shopDomain, status: "PENDING" },
      data: { status: "PROCESSING", progress: 1, errorMessage: null },
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
      const aiResult = await generateProductDescription({
  title: dbJob.productTitle ?? dbJob.productId,
  vendor: dbJob.productVendor ?? "",
  productType: dbJob.productType ?? "",
  tags: dbJob.productTags ? dbJob.productTags.split(",").map(t => t.trim()).filter(Boolean) : [],
  vibe: dbJob.vibe ?? "casual",
  format: dbJob.format ?? "paragraph",
  keywords: keywordsList,
  includeSocials: dbJob.includeSocials ?? false,
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
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: LIMITS.CONCURRENCY,
  },
);

generationWorker.on("ready", () => {
  console.log("[generation.worker] ready — using real AI generation");
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