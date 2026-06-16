// FILE: app/features/jobs/jobs.server.ts
//
// Loader + action for /app/jobs.
// Patched additions vs original app/routes/app.jobs.server.ts:
//   - loader select: added bulkId, result
//   - loader map:    added bulkId, draftBodyHtml, metaTitle, metaDescription
//   - action undo:   restores from ProductSeoSnapshot
//   - action cancel/retry/cancel_all/create: unchanged

import crypto from "node:crypto";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";

import { db } from "../../lib/db.server";
import {
  markBulkOperationActive,
  reconcileBulkOperationStatus,
} from "../../lib/bulkOperation.server";
import { requireAdminSession } from "../../lib/auth.server";
import { generationQueue } from "../../lib/queue.server";
import {
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RETRY_BASE_DELAY_MS,
} from "../../lib/generationJobStates";
import { sanitiseHtml } from "../../lib/html.server";
import {
  checkRateLimit,
  incrementRateLimit,
  resolvePlan,
} from "../../lib/rateLimiter.server";
import {
  CREDIT_COSTS,
  deductCredits,
  refundCredits,
} from "../../lib/creditService.server";

import {
  ACTIVE_STATUSES,
  BULLMQ_REMOVE_BATCH,
  CANCEL_ALL_HARD_CAP,
  MAX_DESTRUCTIVE_OPERATION_BATCH,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  UUID_RE,
} from "../../routes/app.jobs.constants";
import {
  isJobStatus,
  type LoaderData,
  type JobStatus,
} from "../../routes/app.jobs.types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isUuidV4(x: string | null): x is string {
  return !!x && UUID_RE.test(x);
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function idempotencyKey(params: {
  shop: string;
  action: string;
  material: string;
}) {
  return sha256Hex(`${params.shop}:${params.action}:${params.material}`);
}

async function removeBullJobsBestEffort(bullJobIds: string[]) {
  for (let i = 0; i < bullJobIds.length; i += BULLMQ_REMOVE_BATCH) {
    const batch = bullJobIds.slice(i, i + BULLMQ_REMOVE_BATCH);
    await Promise.allSettled(
      batch.map(async (bullJobId) => {
        try {
          const bullJob = await generationQueue.getJob(bullJobId);
          if (bullJob) await bullJob.remove();
        } catch {
          // best-effort
        }
      }),
    );
  }
}

function toIso(d: Date) {
  return d.toISOString();
}

function clampPageSize(value: string | null) {
  if (!value) return PAGE_SIZE;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

// Extract and sanitize body_html from the result JSON column.
// Returns empty string if result is missing or malformed.
function extractBodyHtml(fields: unknown): string {
  if (!fields || typeof fields !== "object") return "";
  const r = fields as Record<string, unknown>;
  if (typeof r.descriptionHtml !== "string") return "";
  return sanitiseHtml(r.descriptionHtml);
}

function extractMetaTitle(fields: unknown): string {
  if (!fields || typeof fields !== "object") return "";
  const r = fields as Record<string, unknown>;
  return typeof r.seoTitle === "string" ? r.seoTitle : "";
}

function extractMetaDescription(fields: unknown): string {
  if (!fields || typeof fields !== "object") return "";
  const r = fields as Record<string, unknown>;
  return typeof r.seoDescription === "string" ? r.seoDescription : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  const { shopDomain } = await requireAdminSession(request);

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor");
  const cursor = isUuidV4(cursorParam) ? cursorParam : null;
  const take = clampPageSize(url.searchParams.get("pageSize"));

  const rows = await db.generationJob.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      bullJobId: true,
      productId: true,
      productTitle: true,
      status: true,
      progress: true,
      costTokens: true,
      errorMessage: true,
      vibe: true,
      format: true,
      generatedDescription: true,
      createdAt: true,
      updatedAt: true,
      bulkId: true, // for tab separation (Individual vs Bulk Runs)
    },
  });

  const hasNextPage = rows.length > take;
  const pageRows = rows.slice(0, take);

  const activeStatuses: readonly JobStatus[] = ACTIVE_STATUSES;
  const hasActiveJobs = pageRows.some(
    (j) => isJobStatus(j.status) && activeStatuses.includes(j.status),
  );

  const totalPending = await db.generationJob.count({
    where: { shopDomain, status: "PENDING" },
  });

  const outputs = await db.generatedSeoOutput.findMany({
    where: {
      shopDomain,
      status: "READY",
      jobId: { in: pageRows.map((row) => row.id) },
    },
    select: { jobId: true, fields: true },
  });
  const outputByJobId = new Map(
    outputs.map((output) => [output.jobId, output.fields]),
  );
  const snapshots = await db.productSeoSnapshot.findMany({
    where: {
      shopDomain,
      jobId: { in: pageRows.map((row) => row.id) },
    },
    select: { jobId: true, productId: true },
  });
  const snapshotKeys = new Set(
    snapshots.map((snapshot) => `${snapshot.jobId}:${snapshot.productId}`),
  );

  return json<LoaderData>({
    jobs: pageRows.map((j) => ({
      id: j.id,
      bullJobId: j.bullJobId,
      productId: j.productId,
      productTitle: j.productTitle,
      status: (isJobStatus(j.status) ? j.status : "FAILED") as JobStatus,
      progress: Number.isFinite(j.progress)
        ? Math.max(0, Math.min(100, Math.floor(j.progress)))
        : 0,
      costTokens: Number.isFinite(j.costTokens)
        ? Math.max(0, Math.floor(j.costTokens))
        : 0,
      errorMessage: j.errorMessage,
      tone: j.vibe ?? null,
      format: j.format ?? null,
      generatedDescription: j.generatedDescription ?? null,
      hasPreviousDescription: snapshotKeys.has(`${j.id}:${j.productId}`),
      createdAt: toIso(j.createdAt),
      updatedAt: toIso(j.updatedAt),
      // ── new fields ──────────────────────────────────────────────────────
      bulkId: j.bulkId ?? null,
      draftBodyHtml: extractBodyHtml(outputByJobId.get(j.id)),
      metaTitle: extractMetaTitle(outputByJobId.get(j.id)),
      metaDescription: extractMetaDescription(outputByJobId.get(j.id)),
    })),
    hasActiveJobs,
    hasNextPage,
    nextCursor: hasNextPage
      ? (pageRows[pageRows.length - 1]?.id ?? null)
      : null,
    prevCursor: cursor,
    totalPending,
    shopDomain,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  const { admin, billing, shopDomain } = await requireAdminSession(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── cancel ────────────────────────────────────────────────────────────────

  if (intent === "cancel") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    const res = await db.$transaction(async (tx) => {
      const jobRecord = await tx.generationJob.findFirst({
        where: { id: jobId, shopDomain },
        select: {
          id: true,
          bullJobId: true,
          status: true,
          updatedAt: true,
          bulkId: true,
        },
      });

      if (!jobRecord)
        return { ok: false as const, status: 404, error: "Job not found" };

      if (jobRecord.status !== "PENDING" && jobRecord.status !== "PROCESSING") {
        if (jobRecord.status === "CANCELLED") {
          return {
            ok: true as const,
            status: 200,
            cancelled: 0,
            alreadyCancelled: true,
          };
        }
        return {
          ok: false as const,
          status: 409,
          error: "Job is not cancellable",
        };
      }

      await tx.generationJob.updateMany({
        where: { id: jobRecord.id, shopDomain },
        data:
          jobRecord.status === "PENDING"
            ? {
                status: "CANCELLED",
                cancelRequested: true,
                cancelledAt: new Date(),
                completedAt: new Date(),
                lockedAt: null,
                lockedBy: null,
              }
            : { cancelRequested: true },
      });

      return {
        ok: true as const,
        status: 200,
        cancelled: 1,
        bullJobId: jobRecord.bullJobId,
        bulkId: jobRecord.bulkId,
      };
    });

    if (!res.ok) {
      return json({ ok: false, error: res.error }, { status: res.status });
    }

    if (res.bullJobId) {
      try {
        const bullJob = await generationQueue.getJob(res.bullJobId);
        if (bullJob) await bullJob.remove();
      } catch (err) {
        console.warn(
          `[cancel] BullMQ remove failed for ${res.bullJobId}:`,
          err,
        );
      }
    }

    await reconcileBulkOperationStatus({
      bulkId: (res as any).bulkId ?? null,
      shopDomain,
    });

    return json({
      ok: true,
      cancelled: res.cancelled,
      alreadyCancelled: (res as any).alreadyCancelled ?? false,
    });
  }

  // ── cancel_all ────────────────────────────────────────────────────────────

  if (intent === "cancel_all") {
    const take = Math.min(CANCEL_ALL_HARD_CAP, MAX_DESTRUCTIVE_OPERATION_BATCH);

    const pendingJobs = await db.generationJob.findMany({
      where: { shopDomain, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true, bullJobId: true, bulkId: true },
      take,
      orderBy: { createdAt: "asc" },
    });

    if (pendingJobs.length === 0) return json({ ok: true, cancelled: 0 });

    const ids = pendingJobs.map((j) => j.id);
    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PENDING" },
      data: {
        status: "CANCELLED",
        cancelRequested: true,
        cancelledAt: new Date(),
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });

    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PROCESSING" },
      data: { cancelRequested: true },
    });

    const bullJobIds = pendingJobs
      .map((j) => j.bullJobId)
      .filter(Boolean) as string[];
    await removeBullJobsBestEffort(bullJobIds);
    await Promise.all(
      Array.from(
        new Set(pendingJobs.map((job) => job.bulkId).filter(Boolean) as string[]),
      ).map((bulkId) => reconcileBulkOperationStatus({ bulkId, shopDomain })),
    );

    return json({ ok: true, cancelled: pendingJobs.length });
  }

  // ── retry ─────────────────────────────────────────────────────────────────

  if (intent === "retry") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    const res = await db.$transaction(async (tx) => {
      const jobRecord = await tx.generationJob.findFirst({
        where: { id: jobId, shopDomain },
        select: {
          id: true,
          shopDomain: true,
          productId: true,
          status: true,
          updatedAt: true,
          vibe: true,
          format: true,
          keywords: true,
          bulkId: true,
          bullJobId: true,
          traceId: true,
          customInstruction: true,
        },
      });

      if (!jobRecord)
        return { ok: false as const, status: 404, error: "Job not found" };

      if (jobRecord.status === "PENDING" || jobRecord.status === "PROCESSING") {
        return {
          ok: true as const,
          status: 200,
          retried: jobRecord.id,
          alreadyQueued: true,
        };
      }

      if (jobRecord.status !== "FAILED") {
        return {
          ok: false as const,
          status: 409,
          error: "Job is not in FAILED state",
        };
      }

      const failureVersion = jobRecord.updatedAt.getTime();
      const idem = idempotencyKey({
        shop: shopDomain,
        action: "retry",
        material: `${jobRecord.id}:${failureVersion}`,
      });
      const short = idem.slice(0, 24);
      const newTraceId = `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const newBullJobId = `${shopDomain}:${jobRecord.id}:retry_${short}`;

      await tx.generationJob.updateMany({
        where: { id: jobRecord.id, shopDomain },
        data: {
          status: "PENDING",
          cancelRequested: false,
          cancelledAt: null,
          completedAt: null,
          attempts: 0,
          maxAttempts: GENERATION_MAX_ATTEMPTS,
          lockedAt: null,
          lockedBy: null,
          nextRunAt: new Date(),
          lastErrorCode: null,
          lastError: null,
          errorMessage: null,
          progress: 0,
          traceId: newTraceId,
          bullJobId: newBullJobId,
        },
      });

      const jobData = {
        traceId: newTraceId,
        jobId: jobRecord.id,
        bulkId: jobRecord.bulkId ?? crypto.randomUUID(),
        shopDomain: jobRecord.shopDomain,
        productId: jobRecord.productId,
        vibe: jobRecord.vibe,
        format: jobRecord.format,
        keywords: jobRecord.keywords,
        customInstruction: jobRecord.customInstruction ?? undefined,
        isStale: false,
      };

      return {
        ok: true as const,
        status: 200,
        retried: jobRecord.id,
        jobData,
        newBullJobId,
      };
    });

    if (!res.ok)
      return json({ ok: false, error: res.error }, { status: res.status });

    if ((res as any).alreadyQueued)
      return json({ ok: true, retried: jobId, alreadyQueued: true });

    const { jobData, newBullJobId } = res as any;
    const { appSubscriptions } = await billing.check();
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
    const rate = await checkRateLimit(shopDomain, plan);

    if (!rate.allowed) {
      await db.generationJob.update({
        where: { id: jobId, shopDomain },
        data: {
          status: "FAILED",
          errorMessage: "Retry throttled. Please try again.",
          lastErrorCode: "RATE_LIMIT_EXCEEDED",
          lastError: "Retry throttled. Please try again.",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          progress: 0,
        },
      });
      return json(
        {
          ok: false,
          error: "Too many generation requests. Please try again in a minute.",
          code: "RATE_LIMIT_EXCEEDED",
        },
        { status: 429 },
      );
    }

    const creditRequestId = `${jobId}:jobs-retry:${crypto.randomUUID()}`;
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId,
      kind: "regeneration",
      metadata: { intent: "jobs_retry", jobId },
    });

    if (!credit.allowed) {
      await db.generationJob.update({
        where: { id: jobId, shopDomain },
        data: {
          status: "FAILED",
          errorMessage: "Insufficient monthly credits for retry.",
          lastErrorCode: "INSUFFICIENT_CREDITS",
          lastError: "Insufficient monthly credits for retry.",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          progress: 0,
        },
      });
      return json(
        {
          ok: false,
          error: "Not enough credits",
          code: "INSUFFICIENT_CREDITS",
          creditsRemaining: credit.creditsRemaining,
          creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(),
        },
        { status: 402 },
      );
    }

    jobData.creditRequestId = creditRequestId;
    jobData.creditCost = CREDIT_COSTS.standardGeneration;
    await db.generationJob.update({
      where: { id: jobId, shopDomain },
      data: { creditRequestId, creditCost: CREDIT_COSTS.standardGeneration },
    });
    await markBulkOperationActive({
      bulkId: jobData.bulkId ?? null,
      shopDomain,
    });

    try {
      await generationQueue.add(`generate:${jobData.productId}`, jobData, {
        jobId: newBullJobId,
        attempts: GENERATION_MAX_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: GENERATION_RETRY_BASE_DELAY_MS,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });
      await incrementRateLimit(shopDomain, plan).catch((error) => {
        console.warn("[retry] rate-limit increment skipped:", error);
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "";
      if (msg.includes("Job") && msg.includes("already exists")) {
        return json({ ok: true, retried: jobId, alreadyQueued: true });
      }
      console.error("[retry] enqueue failed:", err);
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:enqueue-failed`,
        metadata: { intent: "jobs_retry", jobId },
      });
      await db.generationJob.update({
        where: { id: jobId, shopDomain },
        data: {
          status: "FAILED",
          errorMessage: "Retry enqueue failed. Please try again.",
          lastErrorCode: "ENQUEUE_FAILED",
          lastError: "Retry enqueue failed. Please try again.",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          progress: 0,
        },
      });
      return json(
        { ok: false, error: "Retry enqueue failed" },
        { status: 503 },
      );
    }

    return json({ ok: true, retried: jobId });
  }

  // ── create ────────────────────────────────────────────────────────────────

  if (intent === "create") {
    const productId = String(form.get("productId"));
    const productTitle = String(form.get("productTitle"));
    const vibe = String(form.get("vibe"));
    const format = String(form.get("format"));
    const keywords = String(form.get("keywords"));
    const { appSubscriptions } = await billing.check();
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
    const rate = await checkRateLimit(shopDomain, plan);

    if (!rate.allowed) {
      return json(
        {
          ok: false,
          error: "Too many generation requests. Please try again in a minute.",
          code: "RATE_LIMIT_EXCEEDED",
        },
        { status: 429 },
      );
    }

    const creditRequestId = `jobs-create:${crypto.randomUUID()}`;
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId,
      kind: "generation",
      metadata: { intent: "jobs_create", productId },
    });

    if (!credit.allowed) {
      return json(
        {
          ok: false,
          error: "Not enough credits",
          code: "INSUFFICIENT_CREDITS",
          creditsRemaining: credit.creditsRemaining,
          creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(),
        },
        { status: 402 },
      );
    }

    try {
      const job = await db.generationJob.create({
        data: {
          shopDomain,
          productId,
          productTitle,
          vibe,
          format,
          keywords,
          status: "PENDING",
          cancelRequested: false,
          progress: 0,
          attempts: 0,
          maxAttempts: GENERATION_MAX_ATTEMPTS,
          nextRunAt: new Date(),
          completedAt: null,
          traceId: crypto.randomUUID(),
          inputHash: sha256Hex(
            `${shopDomain}:${productId}:${vibe}:${format}:${keywords}`,
          ),
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
        },
      });

      const bullJobId = `${shopDomain}:${job.id}`;
      await db.generationJob.updateMany({
        where: { id: job.id, shopDomain },
        data: { bullJobId },
      });
      await generationQueue.add(
        `generate:${productId}`,
        {
          jobId: job.id,
          shopDomain,
          productTitle,
          vibe,
          format,
          keywords,
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
        },
        {
          jobId: bullJobId,
          attempts: GENERATION_MAX_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: GENERATION_RETRY_BASE_DELAY_MS,
          },
        },
      );
      await incrementRateLimit(shopDomain, plan).catch((error) => {
        console.warn("[jobs-create] rate-limit increment skipped:", error);
      });

      return json({ ok: true, jobId: job.id });
    } catch (err) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:enqueue-failed`,
        metadata: { intent: "jobs_create", productId },
      });
      throw err;
    }
  }

  // ── undo ──────────────────────────────────────────────────────────────────

  if (intent === "undo") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    const jobRecord = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain },
      select: {
        id: true,
        productId: true,
        status: true,
      },
    });

    if (!jobRecord)
      return json({ ok: false, error: "Job not found" }, { status: 404 });

    if (jobRecord.status !== "COMPLETED") {
      return json(
        { ok: false, error: "Only completed jobs can be undone." },
        { status: 422 },
      );
    }

    const snapshot = await db.productSeoSnapshot.findFirst({
      where: {
        shopDomain,
        jobId: jobRecord.id,
        productId: jobRecord.productId,
      },
      select: { fields: true },
      orderBy: { createdAt: "desc" },
    });

    if (!snapshot) {
      return json(
        { ok: false, error: "No product snapshot is available to restore." },
        { status: 422 },
      );
    }

    const snapshotFields =
      snapshot.fields && typeof snapshot.fields === "object"
        ? (snapshot.fields as Record<string, unknown>)
        : {};
    const descriptionToRestore =
      typeof snapshotFields.descriptionHtml === "string"
        ? snapshotFields.descriptionHtml
        : "";

    try {
      const response = await admin.graphql(
        `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id descriptionHtml }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              id: jobRecord.productId,
              descriptionHtml: descriptionToRestore,
            },
          },
        },
      );
      const body = await response.json();
      const userErrors = body?.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e: any) => e.message).join(", ");
        return json(
          { ok: false, error: `Shopify rejected the update: ${msg}` },
          { status: 422 },
        );
      }
    } catch (err) {
      console.error("[undo] Shopify API error:", err);
      return json(
        {
          ok: false,
          error: "Failed to update product on Shopify. Please try again.",
        },
        { status: 502 },
      );
    }

    return json({ ok: true, restored: true });
  }

  return json({ ok: false, error: "Invalid intent" }, { status: 400 });
}
