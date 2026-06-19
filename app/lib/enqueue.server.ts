// FILE: app/lib/enqueue.server.ts

import crypto from "node:crypto";
import { db } from "./db.server";
import { generationQueue } from "./queue.server";

interface EnqueueParams {
  shopDomain: string;
  productIds: string[];
  vibe: string;
  format: string;
  keywords: string;
  includeSocials: boolean;
  customInstruction?: string;
  adminGraphql: (query: string, opts?: any) => Promise<Response>;
  /** Optional: group all jobs under one bulk run ID (uuid). Auto-generated if omitted and productIds.length > 1. */
  bulkId?: string;
}

export interface EnqueueResult {
  jobIds: string[];
  skipped: string[];
  /** Present when multiple products are queued together */
  bulkId: string | null;
}

function hashInput(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function newUuid() {
  return crypto.randomUUID();
}

async function fetchProductMeta(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  productId: string,
) {
  try {
    const response = await adminGraphql(
      `#graphql
      query GetProduct($id: ID!) {
        product(id: $id) {
          id
          title
          vendor
          productType
          tags
        }
      }`,
      { variables: { id: productId } },
    );
    const data = await response.json();
    const p = data?.data?.product;
    if (!p) return null;
    return {
      title: p.title as string,
      vendor: p.vendor as string,
      productType: p.productType as string,
      tags: p.tags as string[],
    };
  } catch (err) {
    console.error(`Failed to fetch product meta for ${productId}:`, err);
    return null;
  }
}

export async function enqueueGenerationJobs({
  shopDomain,
  productIds,
  vibe,
  format,
  keywords,
  includeSocials,
  adminGraphql,
  bulkId: explicitBulkId,
  customInstruction = "",
}: EnqueueParams): Promise<EnqueueResult> {
  const jobIds: string[] = [];
  const skipped: string[] = [];

  // Assign a bulkId when this is a multi-product run so the jobs can be
  // grouped on the History page. Single-product jobs get null unless the
  // caller explicitly passes one.
  const bulkId =
    explicitBulkId ??
    (productIds.length > 1 ? newUuid() : null);

  for (const productId of productIds) {
    const material = `${shopDomain}:${productId}:${vibe}:${format}:${keywords}:${includeSocials}`;
    const inputHash = hashInput(material);

    // Idempotency: reuse an in-flight job with the same parameters — but
    // ONLY if a real BullMQ job still exists behind it.
    //
    // Why this check is necessary: a DB row can end up at PENDING/PROCESSING
    // with NO matching BullMQ job — e.g. if Redis was briefly unreachable
    // when the row was first created (queue.add() never ran or threw), or a
    // worker died mid-claim. If we trust the DB status alone, that orphaned
    // row poisons every future "generate" click with the same parameters:
    // we keep handing back its id, never re-enqueue, and the UI polls
    // PENDING forever. So always verify against Redis before reusing it.
    const existing = await db.generationJob.findFirst({
      where: {
        shopDomain,
        productId,
        inputHash,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true, status: true },
    });

    if (existing) {
      const bullJob = await generationQueue.getJob(existing.id);

      if (bullJob) {
        // Healthy in-flight job — genuinely reuse it.
        jobIds.push(existing.id);
        continue;
      }

      // Orphan detected: DB says PENDING/PROCESSING, Redis has nothing.
      console.warn(
        `[enqueue] Orphaned job ${existing.id} (status=${existing.status}) has no matching BullMQ job — re-enqueueing instead of reusing it.`,
      );

      // Re-add using the SAME job id so we don't create a duplicate DB row.
      // BullMQ's jobId option de-dupes against any still-active job with
      // that id, and cleanly re-creates it if it was actually missing.
      await generationQueue.add(
        `generate:${productId}`,
        {
          jobId: existing.id,
          shopDomain,
          productId,
          vibe,
          format,
          keywords,
          includeSocials,
          customInstruction: customInstruction || undefined,
        },
        { jobId: existing.id },
      );

      // Reset the DB row to a clean PENDING state in case it was stuck in
      // PROCESSING from a worker that died mid-job.
      await db.generationJob.updateMany({
        where: { id: existing.id, shopDomain },
        data: { status: "PENDING", progress: 0, errorMessage: null },
      });

      console.log("[enqueue] Re-enqueued orphaned job:", existing.id);
      jobIds.push(existing.id);
      continue;
    }

    const meta = await fetchProductMeta(adminGraphql, productId);

    if (!meta) {
      console.warn(`Skipping product ${productId}: meta not found`);
      skipped.push(productId);
      continue;
    }

    const job = await db.generationJob.create({
      data: {
        shopDomain,
        productId,
        productTitle: meta.title,
        productVendor: meta.vendor,
        productType: meta.productType,
        productTags: meta.tags.join(","),
        status: "PENDING",
        inputHash,
        vibe,
        format,
        keywords,
        includeSocials,
        isStale: false,
        // ← key addition: tag all jobs in this bulk run
        bulkId,
        customInstruction: customInstruction || null,
      },
    });

    await generationQueue.add(
      `generate:${productId}`,
      {
        jobId: job.id,
        shopDomain,
        productId,
        vibe,
        format,
        keywords,
        includeSocials,
        customInstruction: customInstruction || undefined,
      },
      { jobId: job.id },
    );

    console.log("[enqueue] Job added to Redis queue:", job.id, bulkId ? `(bulk: ${bulkId})` : "");

    jobIds.push(job.id);
  }

  return { jobIds, skipped, bulkId };
}