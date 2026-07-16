// FILE: app/routes/app.api.bulk.$bulkId.tsx
//
// GET /app/api/bulk/:bulkId
// Lightweight, high-frequency-poll-safe status for a bulk run: aggregate
// counts PLUS a slim per-job list (id/title/status/applied) — no HTML/meta
// payload. Safe to poll every few seconds even for 50 jobs.
//
// For full content of ONE job, use GET /app/api/bulk/:bulkId/job/:jobId
// instead — fetched on demand when a preview opens, never on a poll tick.

import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { db } from "../lib/db.server";
import { requireAdminSession } from "../lib/auth.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BulkStatusJob {
  id: string;
  productId: string;
  productTitle: string;
  status: string;
  applied: boolean;
}

export interface BulkStatusPayload {
  bulkId: string;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** 0–100 */
  percentDone: number;
  isDone: boolean;
  jobs: BulkStatusJob[];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { shopDomain } = await requireAdminSession(request);

  const { bulkId } = params;
  if (!bulkId || !UUID_RE.test(bulkId)) {
    return json({ error: "Invalid bulkId" }, { status: 400 });
  }

  const jobs = await db.generationJob.findMany({
    where: { bulkId, shopDomain },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      productId: true,
      productTitle: true,
      status: true,
      generatedDescription: true, // only used as an "applied" boolean flag here
    },
  });

  if (jobs.length === 0) {
    return json({ error: "Bulk run not found" }, { status: 404 });
  }

  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const j of jobs) {
    const s = j.status.toLowerCase() as keyof typeof counts;
    if (s in counts) counts[s]++;
  }

  const total = jobs.length;
  const done = counts.completed + counts.failed + counts.cancelled;
  const percentDone = total === 0 ? 100 : Math.round((done / total) * 100);
  const isDone = done === total;

  const payload: BulkStatusPayload = {
    bulkId,
    total,
    ...counts,
    percentDone,
    isDone,
    jobs: jobs.map((j) => ({
      id: j.id,
      productId: j.productId,
      productTitle: j.productTitle ?? j.productId,
      status: j.status,
      applied: Boolean(j.generatedDescription),
    })),
  };

  return json(payload);
}