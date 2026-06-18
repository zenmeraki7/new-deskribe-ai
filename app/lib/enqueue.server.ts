// FILE: app/lib/enqueue.server.ts

import crypto from "node:crypto";
import { db } from "./db.server";
import { generationJobDefaults, generationQueue } from "./queue.server";
import { appLog, durationSince } from "../utils/observability.server";

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
  context: { shop: string; bulkId?: string | null; requestId?: string | null },
) {
  const startedAt = Date.now();
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
    appLog.info("Fetched product metadata", {
      operation: "generation.fetch_product_meta",
      shop: context.shop,
      bulkId: context.bulkId,
      requestId: context.requestId,
      productId,
      durationMs: durationSince(startedAt),
      status: "success",
    });
    return {
      title: p.title as string,
      vendor: p.vendor as string,
      productType: p.productType as string,
      tags: p.tags as string[],
    };
  } catch (err) {
    appLog.error("Failed to fetch product metadata", {
      operation: "generation.fetch_product_meta",
      shop: context.shop,
      bulkId: context.bulkId,
      requestId: context.requestId,
      productId,
      durationMs: durationSince(startedAt),
      status: "failed",
      error: err,
    });
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
  const startedAt = Date.now();


  // Assign a bulkId when this is a multi-product run so the jobs can be
  // grouped on the History page. Single-product jobs get null unless the
  // caller explicitly passes one.
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
      appLog.info("Reused existing generation job", {
        operation: "generation.enqueue",
        shop: shopDomain,
        jobId: existing.id,
        bulkId,
        requestId: creditRequestId,
        productId,
        status: "reused",
      });
      jobIds.push(existing.id);
      continue;
    }

    const meta = await fetchProductMeta(adminGraphql, productId, {
      shop: shopDomain,
      bulkId,
      requestId: creditRequestId,
    });

    if (!meta) {
      appLog.warn("Skipped generation job because product metadata was unavailable", {
        operation: "generation.enqueue",
        shop: shopDomain,
        bulkId,
        requestId: creditRequestId,
        productId,
        status: "skipped",
      });
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
      { ...generationJobDefaults, jobId: job.id },
    );

    appLog.info("Generation job enqueued", {
      operation: "generation.enqueue",
      shop: shopDomain,
      jobId: job.id,
      bulkId,
      requestId: creditRequestId,
      productId,
      durationMs: durationSince(startedAt),
      status: "queued",
    });

    jobIds.push(job.id);
  }

  appLog.info("Generation enqueue batch completed", {
    operation: "generation.enqueue_batch",
    shop: shopDomain,
    bulkId,
    requestId: creditRequestId,
    durationMs: durationSince(startedAt),
    status: "completed",
    queuedCount: jobIds.length,
    skippedCount: skipped.length,
    requestedCount: productIds.length,
  });

  return { jobIds, skipped, bulkId };
}
