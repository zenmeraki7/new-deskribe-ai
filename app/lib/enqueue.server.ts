// FILE: app/lib/enqueue.server.ts
//
// FIX: BullMQ jobId was `job.id` (bare UUID).
//      All other enqueue sites (jobs.server.ts, app._index.tsx) use
//      `${shopDomain}:${job.id}` as the BullMQ jobId.
//      Using a bare UUID means BullMQ treats these as different jobs and
//      the "already exists" deduplication check never fires correctly.
//      Unified to `${shopDomain}:${job.id}` everywhere.

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
  creditRequestId?: string;
  creditCost?: number;
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
console.log("[enqueue] REDIS_URL:", process.env.REDIS_URL);

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
  creditRequestId,
  creditCost,
}: EnqueueParams): Promise<EnqueueResult> {
  if (!shopDomain) {
    throw new Error("Missing shop context");
  }

  const jobIds: string[] = [];
  const skipped: string[] = [];

  const bulkId =
    explicitBulkId ??
    (productIds.length > 1 ? newUuid() : null);

  for (const productId of productIds) {
    const material = `${shopDomain}:${productId}:${vibe}:${format}:${keywords}:${includeSocials}:${customInstruction || ""}`;
    const inputHash = hashInput(material);

    // Idempotency: reuse an in-flight job with the same parameters
    const existing = await db.generationJob.findFirst({
      where: {
        shopDomain,
        productId,
        inputHash,
        status: { in: ["PENDING", "PROCESSING"] },
        customInstruction: customInstruction || null,
      },
      select: { id: true },
    });

    if (existing) {
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
        bulkId,
        customInstruction: customInstruction || null,
        creditRequestId: creditRequestId ?? null,
        creditCost: creditCost ?? null,
      },
    });

    // FIX: use same `${shopDomain}:${job.id}` format as all other enqueue sites
    // so BullMQ deduplication and job lookup work consistently across the codebase.
    const bullJobId = `${shopDomain}_${job.id}`;

    // Persist the bullJobId on the DB record so the worker and cancel/retry
    // actions can reference it later (matches what jobs.server.ts does).
    await db.generationJob.update({
      where: { id: job.id },
      data: { bullJobId },
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
        creditRequestId: creditRequestId ?? undefined,
        creditCost: creditCost ?? undefined,
      },
      {
        jobId: bullJobId,          // ← FIXED: was bare job.id
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    const counts = await generationQueue.getJobCounts();
console.log("[enqueue] Queue counts:", counts);
    console.log(
      "[enqueue] Job added to Redis queue:",
      job.id,
      `bullJobId=${bullJobId}`,
      bulkId ? `(bulk: ${bulkId})` : "",
    );

    jobIds.push(job.id);
  }

  return { jobIds, skipped, bulkId };
}