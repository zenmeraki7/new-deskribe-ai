// FILE: app/routes/app.bulk.$bulkId.tsx
//
// Full-page bulk review UI.
// GET  /app/bulk/:bulkId  — shows all jobs in a bulk run with preview + apply
// POST /app/bulk/:bulkId  — intent: "apply_one" | "apply_all" | "retry_one"

import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import crypto from "node:crypto";
import {
  markBulkOperationActive,
  markBulkOperationCancelling,
  reconcileBulkOperationStatus,
} from "../lib/bulkOperation.server";
import { db } from "../lib/db.server";
import {
  ApplyNotReadyError,
  ApplyPreconditionError,
  enqueueApplyJob,
} from "../lib/apply.server";
import { adminActorLabel, requireAdminSession } from "../lib/auth.server";
import { sanitiseHtml } from "../lib/html.server";
import { generationQueue } from "../lib/queue.server";
import {
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RETRY_BASE_DELAY_MS,
} from "../lib/generationJobStates";
import BulkReviewPage from "./app.bulk.$bulkId.ui";
import {
  checkRateLimit,
  incrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import {
  CREDIT_COSTS,
  deductCredits,
  refundCredits,
} from "../lib/creditService.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string) {
  return UUID_RE.test(s);
}

function parseDraftHtml(result: any): string {
  if (!result || typeof result !== "object") return "";
  const raw = result.body_html ?? "";
  if (typeof raw !== "string") return "";
  return sanitiseHtml(raw);
}

function parseMeta(result: any) {
  if (!result || typeof result !== "object") return null;
  return {
    meta_title: typeof result.meta_title === "string" ? result.meta_title : "",
    meta_description:
      typeof result.meta_description === "string"
        ? result.meta_description
        : "",
    keywords: Array.isArray(result.keywords)
      ? result.keywords.filter((k: unknown) => typeof k === "string")
      : [],
    social_caption:
      typeof result.social_caption === "string" ? result.social_caption : "",
  };
}

// ── Shopify apply helper ───────────────────────────────────────────────────────

// ── Types shared with UI ───────────────────────────────────────────────────────

export interface BulkJobItem {
  id: string;
  productId: string;
  productTitle: string;
  status: string;
  errorMessage: string | null;
  bodyHtml: string;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  socialCaption: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vibe: string;
  format: string;
}

export interface BulkLoaderData {
  bulkId: string;
  jobs: BulkJobItem[];
  totalCount: number;
  completedCount: number;
  pendingCount: number;
  failedCount: number;
  appliedCount: number;
  shopDomain: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { shopDomain } = await requireAdminSession(request);

  const { bulkId } = params;
  if (!bulkId || !isUuid(bulkId)) {
    throw new Response("Invalid bulk ID", { status: 400 });
  }

  const rawJobs = await db.generationJob.findMany({
    where: { bulkId, shopDomain },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      productId: true,
      productTitle: true,
      status: true,
      errorMessage: true,
      result: true,
      createdAt: true,
      updatedAt: true,
      vibe: true,
      format: true,
      generatedDescription: true,
    },
  });

  if (rawJobs.length === 0) {
    throw new Response("Bulk run not found", { status: 404 });
  }

  const outputs = await db.generatedSeoOutput.findMany({
    where: {
      shopDomain,
      jobId: { in: rawJobs.map((job) => job.id) },
      status: { in: ["READY", "APPLIED"] },
    },
    select: {
      jobId: true,
      fields: true,
      status: true,
      appliedAt: true,
    },
  });
  const outputByJobId = new Map(
    outputs.map((output) => [output.jobId, output]),
  );

  const jobs: BulkJobItem[] = rawJobs.map((j) => {
    const meta = parseMeta(j.result);
    const output = outputByJobId.get(j.id);
    const outputFields =
      output?.fields && typeof output.fields === "object"
        ? (output.fields as Record<string, unknown>)
        : {};
    const outputDescription =
      typeof outputFields.descriptionHtml === "string"
        ? sanitiseHtml(outputFields.descriptionHtml)
        : "";
    return {
      id: j.id,
      productId: j.productId,
      productTitle: j.productTitle ?? j.productId,
      status: j.status,
      errorMessage: j.errorMessage ?? null,
      bodyHtml: outputDescription || parseDraftHtml(j.result),
      metaTitle:
        typeof outputFields.seoTitle === "string"
          ? outputFields.seoTitle
          : (meta?.meta_title ?? ""),
      metaDescription:
        typeof outputFields.seoDescription === "string"
          ? outputFields.seoDescription
          : (meta?.meta_description ?? ""),
      keywords: meta?.keywords ?? [],
      socialCaption: meta?.social_caption ?? "",
      // We track "applied" by checking if generatedDescription is set (written to Shopify)
      appliedAt:
        output?.status === "APPLIED" || output?.appliedAt || j.generatedDescription
          ? (output?.appliedAt ?? j.updatedAt).toISOString()
          : null,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      vibe: j.vibe ?? "",
      format: j.format ?? "",
    };
  });

  const completedCount = jobs.filter((j) => j.status === "COMPLETED").length;
  const pendingCount = jobs.filter(
    (j) => j.status === "PENDING" || j.status === "PROCESSING",
  ).length;
  const failedCount = jobs.filter((j) => j.status === "FAILED").length;
  const appliedCount = jobs.filter((j) => j.appliedAt !== null).length;

  const data: BulkLoaderData = {
    bulkId,
    jobs,
    totalCount: jobs.length,
    completedCount,
    pendingCount,
    failedCount,
    appliedCount,
    shopDomain,
  };

  return json(data);
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const authContext = await requireAdminSession(request);
  const { billing, shopDomain } = authContext;
  const requestedBy = adminActorLabel(authContext);

  const { bulkId } = params;
  if (!bulkId || !isUuid(bulkId)) {
    return json({ ok: false, error: "Invalid bulk ID" }, { status: 400 });
  }

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // ── apply_one ──────────────────────────────────────────────────────────────
  if (intent === "cancel_bulk") {
    await markBulkOperationCancelling({ bulkId, shopDomain });

    const activeJobs = await db.generationJob.findMany({
      where: {
        bulkId,
        shopDomain,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true, bullJobId: true },
    });

    if (activeJobs.length === 0) {
      const status = await reconcileBulkOperationStatus({ bulkId, shopDomain });
      return json({ ok: true, intent: "cancel_bulk", cancelled: 0, status });
    }

    const ids = activeJobs.map((job) => job.id);
    const now = new Date();
    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PENDING" },
      data: {
        status: "CANCELLED",
        cancelRequested: true,
        cancelledAt: now,
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
      },
    });
    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PROCESSING" },
      data: { cancelRequested: true },
    });

    await Promise.allSettled(
      activeJobs
        .map((job) => job.bullJobId ?? job.id)
        .map(async (bullJobId) => {
          const bullJob = await generationQueue.getJob(bullJobId);
          if (bullJob) await bullJob.remove();
        }),
    );

    const status = await reconcileBulkOperationStatus({ bulkId, shopDomain });
    return json({
      ok: true,
      intent: "cancel_bulk",
      cancelled: activeJobs.length,
      status,
    });
  }

  if (intent === "apply_one") {
    const jobId = String(fd.get("jobId") ?? "");
    if (!isUuid(jobId)) {
      return json({ ok: false, error: "Invalid jobId" }, { status: 400 });
    }

    const job = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain, bulkId, status: "COMPLETED" },
      select: { id: true, productId: true },
    });

    if (!job) {
      return json(
        { ok: false, error: "Job not found or not completed" },
        { status: 404 },
      );
    }

    try {
      const result = await enqueueApplyJob({
        shopDomain,
        jobId: job.id,
        productIds: [job.productId],
        requestedBy,
      });

      return json({
        ok: true,
        intent: "apply_one",
        jobId,
        applyId: result.applyId,
      });
    } catch (error) {
      if (error instanceof ApplyNotReadyError) {
        return json(
          { ok: false, error: error.message, code: error.code },
          { status: error.status },
        );
      }
      if (error instanceof ApplyPreconditionError) {
        return json(
          { ok: false, error: error.message, code: error.code },
          { status: error.status },
        );
      }

      return json(
        { ok: false, error: "Apply could not be queued" },
        { status: 500 },
      );
    }
  }

  // ── apply_all ─────────────────────────────────────────────────────────────
  if (intent === "apply_all") {
    const jobs = await db.generationJob.findMany({
      where: {
        bulkId,
        shopDomain,
        status: "COMPLETED",
      },
      select: { id: true, productId: true },
    });

    const results = await Promise.allSettled(
      jobs.map((job) =>
        enqueueApplyJob({
          shopDomain,
          jobId: job.id,
          productIds: [job.productId],
          requestedBy,
        }),
      ),
    );

    const queued = results.filter((result) => result.status === "fulfilled");
    const failed = results.length - queued.length;

    return json({
      ok: true,
      intent: "apply_all",
      succeeded: queued.length,
      failed,
      total: jobs.length,
      queued: true,
    });
  }

  // ── retry_one ─────────────────────────────────────────────────────────────
  if (intent === "retry_one") {
    const jobId = String(fd.get("jobId") ?? "");
    if (!isUuid(jobId)) {
      return json({ ok: false, error: "Invalid jobId" }, { status: 400 });
    }
    const { appSubscriptions } = await billing.check();
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
    const limitResult = await checkRateLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      return json(
        {
          ok: false,
          error: "Too many generation requests. Please try again in a minute.",
          code: "RATE_LIMIT_EXCEEDED",
        },
        { status: 429 },
      );
    }

    const job = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain, bulkId, status: "FAILED" },
      select: {
        id: true,
        productId: true,
        vibe: true,
        format: true,
        keywords: true,
      },
    });

    if (!job) {
      return json(
        { ok: false, error: "Job not found or not failed" },
        { status: 404 },
      );
    }

    const creditRequestId = `${job.id}:retry:${crypto.randomUUID()}`;
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId,
      kind: "regeneration",
      metadata: {
        intent: "retry_one",
        jobId: job.id,
        productId: job.productId,
      },
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
      await db.generationJob.updateMany({
        where: { id: jobId, shopDomain, bulkId },
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
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
        },
      });
      await markBulkOperationActive({ bulkId, shopDomain });

      await generationQueue.add(
        `generate:${job.productId}`,
        {
          jobId: job.id,
          shopDomain,
          productId: job.productId,
          vibe: job.vibe,
          format: job.format,
          keywords: job.keywords,
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
          isStale: false,
        },
        {
          jobId: job.id,
          attempts: GENERATION_MAX_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: GENERATION_RETRY_BASE_DELAY_MS,
          },
        },
      );
      await incrementRateLimit(shopDomain, plan).catch((error) => {
        console.warn("[bulk-retry] rate-limit increment skipped:", error);
      });
    } catch (err) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:retry-enqueue-error`,
        metadata: {
          intent: "retry_one",
          jobId: job.id,
          productId: job.productId,
        },
      });
      throw err;
    }

    return json({ ok: true, intent: "retry_one", jobId });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}

export default BulkReviewPage;
