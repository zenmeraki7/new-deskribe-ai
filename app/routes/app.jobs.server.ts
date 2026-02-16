// FILE: app/routes/app.jobs.server.ts
import crypto from "node:crypto";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";
import { generationQueue } from "../lib/queue.server";

import {
  ACTIVE_STATUSES,
  BULLMQ_REMOVE_BATCH,
  CANCEL_ALL_HARD_CAP,
  MAX_DESTRUCTIVE_OPERATION_BATCH,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  UUID_RE,
} from "./app.jobs.constants";
import { isJobStatus, type LoaderData, type JobStatus } from "./app.jobs.types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (server-only)
// ─────────────────────────────────────────────────────────────────────────────

function isUuidV4(x: string | null): x is string {
  return !!x && UUID_RE.test(x);
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic idempotency key for actions that can be double-submitted.
 * - Includes shop scope
 * - Includes an action name
 * - Includes a stable "version" so retries can become new idempotency keys when appropriate
 */
function idempotencyKey(params: { shop: string; action: string; material: string }) {
  const raw = `${params.shop}:${params.action}:${params.material}`;
  return sha256Hex(raw);
}

async function removeBullJobsBestEffort(bullJobIds: string[]) {
  // Defensive batching to avoid Redis/queue spikes on large shops.
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

// ─────────────────────────────────────────────────────────────────────────────
// Loader — cursor-based pagination, shop-scoped
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  // Hard requirement: every request authenticated & shop-scoped
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor"); // last seen job id
  const cursor = isUuidV4(cursorParam) ? cursorParam : null;

  // Optional future-proofing: if a client ever adds `pageSize`, enforce server cap.
  const take = clampPageSize(url.searchParams.get("pageSize"));

  const rows = await db.generationJob.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1,
        }
      : {}),
    select: {
      id: true,
      bullJobId: true,
      productId: true,
      productTitle: true,
      status: true,
      progress: true,
      costTokens: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const hasNextPage = rows.length > take;
  const pageRows = rows.slice(0, take);

  // Fail-closed: if status is unexpected, treat as not active.
  const hasActiveJobs = pageRows.some((j) => isJobStatus(j.status) && ACTIVE_STATUSES.includes(j.status));

  const totalPending = await db.generationJob.count({
    where: { shopDomain, status: "PENDING" },
  });

  // Map with explicit coercions (avoid leaking Date objects)
  return json<LoaderData>({
    jobs: pageRows.map((j) => ({
      id: j.id,
      bullJobId: j.bullJobId,
      productId: j.productId,
      productTitle: j.productTitle,
      status: (isJobStatus(j.status) ? j.status : "FAILED") as JobStatus, // safest default
      progress: Number.isFinite(j.progress) ? Math.max(0, Math.min(100, Math.floor(j.progress))) : 0,
      costTokens: Number.isFinite(j.costTokens) ? Math.max(0, Math.floor(j.costTokens)) : 0,
      errorMessage: j.errorMessage,
      createdAt: toIso(j.createdAt),
      updatedAt: toIso(j.updatedAt),
    })),
    hasActiveJobs,
    hasNextPage,
    nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
    prevCursor: cursor, // UI can ignore or use a stack pattern later
    totalPending,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — cancel | cancel_all | retry (shop-scoped, idempotent where possible)
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  // Hard requirement: every request authenticated & shop-scoped
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ───────────────────────────────────────────────────────────────────────────
  // cancel (PENDING only)
  // ───────────────────────────────────────────────────────────────────────────

  if (intent === "cancel") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    // Transaction ensures "find pending then cancel" is consistent under concurrency.
    const res = await db.$transaction(async (tx) => {
      const jobRecord = await tx.generationJob.findFirst({
        where: { id: jobId, shopDomain },
        select: { id: true, bullJobId: true, status: true, updatedAt: true },
      });

      if (!jobRecord) return { ok: false as const, status: 404, error: "Job not found" };

      if (jobRecord.status !== "PENDING") {
        // Idempotent: if already cancelled, report success. Otherwise conflict.
        if (jobRecord.status === "CANCELLED") {
          return { ok: true as const, status: 200, cancelled: 0, alreadyCancelled: true };
        }
        return { ok: false as const, status: 409, error: "Job not pending" };
      }

      // Write DB first to make action idempotent under double submits.
      await tx.generationJob.update({
        where: { id: jobRecord.id },
        data: { status: "CANCELLED" },
      });

      return { ok: true as const, status: 200, cancelled: 1, bullJobId: jobRecord.bullJobId };
    });

    if (!res.ok) {
      return json({ ok: false, error: res.error }, { status: res.status });
    }

    // Best-effort: remove from queue after DB state is authoritative.
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

  // ───────────────────────────────────────────────────────────────────────────
  // cancel_all (PENDING only; hard-capped)
  // ───────────────────────────────────────────────────────────────────────────

  if (intent === "cancel_all") {
    // Enforce safety caps (fail closed).
    const take = Math.min(CANCEL_ALL_HARD_CAP, MAX_DESTRUCTIVE_OPERATION_BATCH);

    const pendingJobs = await db.generationJob.findMany({
      where: { shopDomain, status: "PENDING" },
      select: { id: true, bullJobId: true },
      take,
      orderBy: { createdAt: "asc" }, // deterministic selection under cap
    });

    if (pendingJobs.length === 0) {
      return json({ ok: true, cancelled: 0 });
    }

    // Update DB first so UI doesn't lie if queue removal is partial.
    const ids = pendingJobs.map((j) => j.id);
    await db.generationJob.updateMany({
      where: { id: { in: ids }, shopDomain, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    // Best-effort remove from queue (may fail; DB is source of truth).
    const bullJobIds = pendingJobs.map((j) => j.bullJobId).filter(Boolean) as string[];
    await removeBullJobsBestEffort(bullJobIds);

    return json({ ok: true, cancelled: pendingJobs.length });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // retry (FAILED -> PENDING; deterministic idempotency key; queue add idempotent)
  // ───────────────────────────────────────────────────────────────────────────

  if (intent === "retry") {
    const jobId = String(form.get("jobId") ?? "");
    if (!UUID_RE.test(jobId)) {
      return json({ ok: false, error: "Invalid job ID" }, { status: 400 });
    }

    /**
     * Idempotency behavior (hard requirement):
     * - Double-click Retry should enqueue at most once.
     * - Keyed by FAILED "version" (updatedAt) so a new failure enables a new retry.
     * - DB is updated first within a transaction to gate concurrent retries.
     */
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
        },
      });

      if (!jobRecord) return { ok: false as const, status: 404, error: "Job not found" };

      // If already pending/processing due to a concurrent retry click, return OK idempotently.
      if (jobRecord.status === "PENDING" || jobRecord.status === "PROCESSING") {
        return { ok: true as const, status: 200, retried: jobRecord.id, alreadyQueued: true };
      }

      if (jobRecord.status !== "FAILED") {
        return { ok: false as const, status: 409, error: "Job is not in FAILED state" };
      }

      const failureVersion = jobRecord.updatedAt.getTime(); // stable per FAILED state
      const idem = idempotencyKey({
        shop: shopDomain,
        action: "retry",
        material: `${jobRecord.id}:${failureVersion}`,
      });

      // BullMQ jobId cap varies; keep short but deterministic.
      const short = idem.slice(0, 24);
      const newTraceId = `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const newBullJobId = `${shopDomain}:${jobRecord.id}:retry_${short}`;

      // Update DB first to make retry idempotent under concurrency.
      await tx.generationJob.update({
        where: { id: jobRecord.id },
        data: {
          status: "PENDING",
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
        includeSocials: jobRecord.includeSocials,
      };

      return { ok: true as const, status: 200, retried: jobRecord.id, jobData, newBullJobId };
    });

    if (!res.ok) {
      return json({ ok: false, error: res.error }, { status: res.status });
    }

    // If it was already queued by another click, don't enqueue again.
    if ((res as any).alreadyQueued) {
      return json({ ok: true, retried: jobId, alreadyQueued: true });
    }

    const { jobData, newBullJobId } = res as any;

    try {
      // BullMQ add is idempotent when jobId is stable: it will throw if duplicate.
      // We treat duplicate as success (another request already enqueued).
      await generationQueue.add(`generate:${jobData.productId}`, jobData, {
        jobId: newBullJobId,
        removeOnComplete: true,
        removeOnFail: false, // keep failed for debugging; DB is authoritative anyway
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "";

      // Duplicate job id -> idempotent success.
      if (msg.includes("Job") && msg.includes("already exists")) {
        return json({ ok: true, retried: jobId, alreadyQueued: true });
      }

      // Fail closed: revert DB state to FAILED if enqueue failed, so the UI doesn't lie.
      console.error("[retry] enqueue failed:", err);

      await db.generationJob.update({
        where: { id: jobId, shopDomain },
        data: {
          status: "FAILED",
          errorMessage: "Retry enqueue failed. Please try again.",
          progress: 0,
        },
      });

      return json({ ok: false, error: "Retry enqueue failed" }, { status: 503 });
    }

    return json({ ok: true, retried: jobId });
  }

  return json({ ok: false, error: "Invalid intent" }, { status: 400 });
}
