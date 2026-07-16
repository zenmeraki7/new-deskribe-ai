// FILE: app/routes/app.api.bulk.$bulkId.job.$jobId.tsx
//
// GET /app/api/bulk/:bulkId/job/:jobId
// Full content for ONE job — HTML, meta, keywords, social caption.
// Fetched only when a preview opens, never polled.

import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { db } from "../lib/db.server";
import { requireAdminSession } from "../lib/auth.server";
import { toBulkJobItem, type BulkJobItem } from "../lib/bulkJob.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string) {
  return UUID_RE.test(s);
}

export interface BulkJobDetailPayload {
  job: BulkJobItem;
  shopDomain: string;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { shopDomain } = await requireAdminSession(request);

  const { bulkId, jobId } = params;
  if (!bulkId || !isUuid(bulkId)) {
    return json({ error: "Invalid bulkId" }, { status: 400 });
  }
  if (!jobId || !isUuid(jobId)) {
    return json({ error: "Invalid jobId" }, { status: 400 });
  }

  const row = await db.generationJob.findFirst({
    where: { id: jobId, bulkId, shopDomain },
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

  if (!row) {
    return json({ error: "Job not found" }, { status: 404 });
  }

  const payload: BulkJobDetailPayload = { job: toBulkJobItem(row), shopDomain };
  return json(payload);
}