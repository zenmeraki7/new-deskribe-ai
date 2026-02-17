// FILE: app/workers/generation.worker.ts
// Worker for processing "generation" jobs.
// IMPORTANT: This file MUST be executed by a Node process (separate worker process
// or explicitly imported by a worker entry). If it’s never imported/run, jobs will
// remain PENDING and UI shows "Job queued, starting shortly…".

import { Worker, type Job } from "bullmq";
import { z } from "zod";

import { db } from "../lib/db.server";
import { redisConnection } from "../lib/queue.server";
import { sanitiseHtml } from "../lib/html.server";

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
  keywords?: string; // CSV
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

function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clampLen(s: string, max: number) {
  const v = String(s ?? "");
  return v.length <= max ? v : v.slice(0, max);
}

/**
 * Deterministic safe draft generator (until real DeepSeek "generate" exists in your repo).
 * This is server-owned HTML and still goes through allowlist sanitizer.
 */
function buildDeterministicDraft(input: {
  productId: string;
  productTitle?: string | null;
  vendor?: string | null;
  productType?: string | null;
  format?: string | null;
  keywordsCsv?: string | null;
  includeSocials?: boolean | null;
}): DraftResult {
  const title = (input.productTitle || input.productId || "Product").toString();
  const vendor = (input.vendor || "").toString();
  const productType = (input.productType || "").toString();

  const keywords =
    (input.keywordsCsv || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40) || [];

  const primary = keywords[0] || undefined;

  const rawHtml =
    input.format === "bullets"
      ? `<p><strong>${escapeHtml(title)}</strong></p><ul>${[
          vendor ? `<li>Brand: ${escapeHtml(vendor)}</li>` : "",
          productType ? `<li>Type: ${escapeHtml(productType)}</li>` : "",
          primary ? `<li>Primary keyword: ${escapeHtml(primary)}</li>` : "",
        ]
          .filter(Boolean)
          .join("")}</ul>`
      : `<p><strong>${escapeHtml(title)}</strong></p><p>${
          vendor ? `Brand: ${escapeHtml(vendor)}. ` : ""
        }${productType ? `Type: ${escapeHtml(productType)}. ` : ""}${
          primary ? `Targeting: ${escapeHtml(primary)}.` : ""
        }</p>`;

  const body_html = sanitiseHtml(rawHtml);

  const meta_title = clampLen(`${title}${primary ? ` | ${primary}` : ""}`, 500);
  const meta_description = clampLen(
    `${title}${vendor ? ` by ${vendor}` : ""}${productType ? ` (${productType})` : ""}${
      primary ? ` — ${primary}.` : "."
    }`,
    2000,
  );

  const social_caption = input.includeSocials
    ? clampLen(`Check out ${title}${primary ? ` — ${primary}` : ""}!`, 2000)
    : undefined;

  return DraftSchema.parse({
    body_html,
    meta_title,
    meta_description,
    keywords: keywords.length ? keywords : undefined,
    primary_keyword: primary,
    headline: clampLen(title, 500),
    social_caption,
  });
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

    // Shop-scoped: DB is source of truth
    const dbJob = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain },
      select: {
        id: true,
        status: true,
        productId: true,
        productTitle: true,
        keywords: true,
        format: true,
        includeSocials: true,
      },
    });

    if (!dbJob) return { ok: false, code: "JOB_NOT_FOUND" as const };

    // Terminal idempotency exits
    if (dbJob.status === "COMPLETED") return { ok: true, already: "COMPLETED" as const };
    if (dbJob.status === "CANCELLED") return { ok: true, already: "CANCELLED" as const };
    if (dbJob.status === "FAILED") return { ok: true, already: "FAILED" as const };

    // Only process PENDING; otherwise another worker or state change is in progress.
    if (dbJob.status !== "PENDING") return { ok: true, already: dbJob.status as const };

    // Claim atomically: PENDING -> PROCESSING
    const claimed = await db.generationJob.updateMany({
      where: { id: jobId, shopDomain, status: "PENDING" },
      data: { status: "PROCESSING", progress: 1, errorMessage: null },
    });

    if (claimed.count !== 1) {
      return { ok: true, already: "CLAIMED_BY_OTHER" as const };
    }

    try {
      await setProgressSafe(jobId, shopDomain, 10);

      // Until a real DeepSeek generation function exists, create a deterministic safe draft
      const draft = buildDeterministicDraft({
        productId: dbJob.productId,
        productTitle: dbJob.productTitle,
        format: dbJob.format,
        keywordsCsv: dbJob.keywords,
        includeSocials: dbJob.includeSocials,
      });

      await setProgressSafe(jobId, shopDomain, 80);
      await markCompleted(jobId, shopDomain, draft, 0);

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
  console.log("[generation.worker] ready");
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
