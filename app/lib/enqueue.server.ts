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
  if (!shopDomain) throw new Error("Missing shop context");

  console.log("[bullmq-audit][enqueue] called", {
    shopDomain,
    productCount: productIds.length,
    explicitBulkId,
    queueName: generationQueue.name,
  });

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

    // Idempotency: reuse an in-flight job with the same parameters
    const existing = await db.generationJob.findFirst({
      where: {
        shopDomain,
        productId,
        inputHash,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true },
    });

    if (existing) {
      console.log("[bullmq-audit][enqueue] existing active job reused", {
        generationJobId: existing.id,
        productId,
      });
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
        creditRequestId: creditRequestId ?? null,
        creditCost: creditCost ?? null,
      },
    });

    console.log("[bullmq-audit][enqueue] GenerationJob created", {
      generationJobId: job.id,
      productId,
      status: job.status,
      bullJobId: job.bullJobId,
    });

    const payload = {
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
    };

    console.log("[bullmq-audit][enqueue] queue.add starting", {
      queueName: generationQueue.name,
      bullJobIdOption: job.id,
      jobName: `generate:${productId}`,
      payload,
    });

    const bullJob = await generationQueue.add(
      `generate:${productId}`,
      payload,
      { jobId: job.id },
    );

    console.log("[bullmq-audit][enqueue] queue.add succeeded", {
      queueName: generationQueue.name,
      returnedBullJobId: bullJob.id,
      generationJobId: job.id,
    });

    console.log("[enqueue] Job added to Redis queue:", job.id, bulkId ? `(bulk: ${bulkId})` : "");

    await db.generationJob.update({
      where: { id: job.id },
      data: { bullJobId: String(bullJob.id) },
    });

    const storedJob = await db.generationJob.findUnique({
      where: { id: job.id },
      select: { id: true, status: true, bullJobId: true },
    });

    console.log("[bullmq-audit][enqueue] GenerationJob after queue.add", storedJob);

    jobIds.push(job.id);
  }

  return { jobIds, skipped, bulkId };
}
