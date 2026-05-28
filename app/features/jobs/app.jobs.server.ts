// FILE: app/features/jobs/jobs.server.ts
//
// Loader + action for /app/jobs.
// Patched additions vs original app/routes/app.jobs.server.ts:
//   - loader select: added bulkId, result
//   - loader map:    added bulkId, draftBodyHtml, metaTitle, metaDescription
//   - action undo:   unchanged
//   - action cancel/retry/cancel_all/create: unchanged

import crypto from "node:crypto";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../../shopify.server";
import { db } from "../../lib/db.server";
import { generationQueue } from "../../lib/queue.server";
import { sanitiseHtml } from "../../lib/html.server";

import {
  ACTIVE_STATUSES,
  BULLMQ_REMOVE_BATCH,
  CANCEL_ALL_HARD_CAP,
  MAX_DESTRUCTIVE_OPERATION_BATCH,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  UUID_RE,
} from "../../routes/app.jobs.constants";
import { isJobStatus, type LoaderData, type JobStatus } from "../../routes/app.jobs.types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isUuidV4(x: string | null): x is string {
  return !!x && UUID_RE.test(x);
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function idempotencyKey(params: { shop: string; action: string; material: string }) {
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
function extractBodyHtml(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.body_html !== "string") return "";
  return sanitiseHtml(r.body_html);
}

function extractMetaTitle(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  return typeof r.meta_title === "string" ? r.meta_title : "";
}

function extractMetaDescription(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  return typeof r.meta_description === "string" ? r.meta_description : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

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
      previousDescription: true,
      createdAt: true,
      updatedAt: true,
      // ── new fields ──────────────────────────────────────────────────────
      bulkId: true,   // for tab separation (Individual vs Bulk Runs)
      result: true,   // for draftBodyHtml / metaTitle / metaDescription
    },
  });

  const hasNextPage = rows.length > take;
  const pageRows = rows.slice(0, take);

  const hasActiveJobs = pageRows.some(
    (j) => isJobStatus(j.status) && ACTIVE_STATUSES.includes(j.status),
  );

  const totalPending = await db.generationJob.count({
    where: { shopDomain, status: "PENDING" },
  });

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
      costTokens: Number.isFinite(j.costTokens) ? Math.max(0, Math.floor(j.costTokens)) : 0,
      errorMessage: j.errorMessage,
      tone: j.vibe ?? null,
      format: j.format ?? null,
      generatedDescription: j.generatedDescription ?? null,
      hasPreviousDescription: !!j.previousDescription,
      createdAt: toIso(j.createdAt),
      updatedAt: toIso(j.updatedAt),
      // ── new fields ──────────────────────────────────────────────────────
      bulkId: j.bulkId ?? null,
      draftBodyHtml: extractBodyHtml(j.result),
      metaTitle: extractMetaTitle(j.result),
      metaDescription: extractMetaDescription(j.result),
    })),
    hasActiveJobs,
    hasNextPage,
    nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    prevCursor: cursor,
    totalPending,
    shopDomain,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

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
        select: { id: true, bullJobId: true, status: true, updatedAt: true },
      });

      if (!jobRecord) return { ok: false as const, status: 404, error: "Job not found" };

      if (jobRecord.status !== "PENDING") {
        if (jobRecord.status === "CANCELLED") {
          return { ok: true as const, status: 200, cancelled: 0, alreadyCancelled: true };
        }
        return { ok: false as const, status: 409, error: "Job not pending" };
      }

      await tx.generationJob.update({
        where: { id: jobRecord.id },
        data: { status: "CANCELLED" },
      });

      return { ok: true as const, status: 200, cancelled: 1, bullJobId: jobRecord.bullJobId };
    });

    if (!res.ok) {
      return json({ ok: false, error: res.error }, { status: res.status });
    }

    if (res.bullJobId) {
      try {
        const bullJob = await generationQueue.getJob(res.bullJobId);
        if (bullJob) await bullJob.remove();
      } catch (err) {
        console.warn(`[cancel] BullMQ remove failed for ${res.bullJobId}:`, err);
      }
    }

    return json({ ok: true, cancelled: res.cancelled, alreadyCancelled: (res as any).alreadyCancelled ?? false });
  }

  // ── cancel_all ────────────────────────────────────────────────────────────

  if (intent === "cancel_all") {
    const take = Math.min(CANCEL_ALL_HARD_CAP, MAX_DESTRUCTIVE_OPERATION_BATCH);

    const pendingJobs = await db.generationJob.findMany({
      where: { shopDomain, status: "PENDING" },
      select: { id: true, bullJobId: true },
      take,
      orderBy: { createdAt: "asc" },
    });

    if (pendingJobs.length === 0) return json({ ok: true, cancelled: 0 });

    const ids = pendingJobs.map((j) => j.id);
    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    const bullJobIds = pendingJobs.map((j) => j.bullJobId).filter(Boolean) as string[];
    await removeBullJobsBestEffort(bullJobIds);

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
          includeSocials: true,
          bulkId: true,
          bullJobId: true,
          traceId: true,
          customInstruction: true,
        },
      });

      if (!jobRecord) return { ok: false as const, status: 404, error: "Job not found" };

      if (jobRecord.status === "PENDING" || jobRecord.status === "PROCESSING") {
        return { ok: true as const, status: 200, retried: jobRecord.id, alreadyQueued: true };
      }

      if (jobRecord.status !== "FAILED") {
        return { ok: false as const, status: 409, error: "Job is not in FAILED state" };
      }

      const failureVersion = jobRecord.updatedAt.getTime();
      const idem = idempotencyKey({ shop: shopDomain, action: "retry", material: `${jobRecord.id}:${failureVersion}` });
      const short = idem.slice(0, 24);
      const newTraceId = `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const newBullJobId = `${shopDomain}:${jobRecord.id}:retry_${short}`;

      await tx.generationJob.update({
        where: { id: jobRecord.id },
        data: { status: "PENDING", errorMessage: null, progress: 0, traceId: newTraceId, bullJobId: newBullJobId },
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
        includeSocials: jobRecord.includeSocials,
        customInstruction: jobRecord.customInstruction ?? undefined,
      };

      return { ok: true as const, status: 200, retried: jobRecord.id, jobData, newBullJobId };
    });

    if (!res.ok) return json({ ok: false, error: res.error }, { status: res.status });

    if ((res as any).alreadyQueued) return json({ ok: true, retried: jobId, alreadyQueued: true });

    const { jobData, newBullJobId } = res as any;

    try {
      await generationQueue.add(`generate:${jobData.productId}`, jobData, {
        jobId: newBullJobId,
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "";
      if (msg.includes("Job") && msg.includes("already exists")) {
        return json({ ok: true, retried: jobId, alreadyQueued: true });
      }
      console.error("[retry] enqueue failed:", err);
      await db.generationJob.update({
        where: { id: jobId, shopDomain },
        data: { status: "FAILED", errorMessage: "Retry enqueue failed. Please try again.", progress: 0 },
      });
      return json({ ok: false, error: "Retry enqueue failed" }, { status: 503 });
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

    const job = await db.generationJob.create({
      data: {
        shopDomain, productId, productTitle, vibe, format, keywords,
        status: "PENDING", progress: 0,
        traceId: crypto.randomUUID(),
        inputHash: sha256Hex(`${shopDomain}:${productId}:${vibe}:${format}:${keywords}`),
        includeSocials: false,
      },
    });

    const bullJobId = `${shopDomain}:${job.id}`;
    await db.generationJob.update({ where: { id: job.id }, data: { bullJobId } });
    await generationQueue.add(
      `generate:${productId}`,
      { jobId: job.id, shopDomain, productTitle, vibe, format, keywords },
      { jobId: bullJobId },
    );

    return json({ ok: true, jobId: job.id });
  }

  // ── undo ──────────────────────────────────────────────────────────────────

  if (intent === "undo") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    const jobRecord = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain },
      select: { id: true, productId: true, status: true, generatedDescription: true, previousDescription: true },
    });

    if (!jobRecord) return json({ ok: false, error: "Job not found" }, { status: 404 });

    if (jobRecord.status !== "COMPLETED") {
      return json({ ok: false, error: "Only completed jobs can be undone." }, { status: 422 });
    }

    const descriptionToRestore = jobRecord.previousDescription ?? "";

    try {
      const response = await admin.graphql(
        `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id descriptionHtml }
            userErrors { field message }
          }
        }`,
        { variables: { input: { id: jobRecord.productId, descriptionHtml: descriptionToRestore } } },
      );
      const body = await response.json();
      const userErrors = body?.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e: any) => e.message).join(", ");
        return json({ ok: false, error: `Shopify rejected the update: ${msg}` }, { status: 422 });
      }
    } catch (err) {
      console.error("[undo] Shopify API error:", err);
      return json({ ok: false, error: "Failed to update product on Shopify. Please try again." }, { status: 502 });
    }

    await db.generationJob.update({
      where: { id: jobId },
      data: { previousDescription: null, status: "UNDONE" },
    });

    return json({ ok: true, restored: true });
  }

  return json({ ok: false, error: "Invalid intent" }, { status: 400 });
}