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
  adminGraphql: (query: string, opts?: any) => Promise<Response>;
}

function hashInput(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function fetchProductMeta(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  productId: string
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
      { variables: { id: productId } }
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
}: EnqueueParams): Promise<{ jobIds: string[]; skipped: string[] }> {
  const jobIds: string[] = [];
  const skipped: string[] = [];

  for (const productId of productIds) {
    const material = `${shopDomain}:${productId}:${vibe}:${format}:${keywords}:${includeSocials}`;
    const inputHash = hashInput(material);

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
      },
      {
        jobId: job.id,
      },
    );
    console.log("[enqueue] Job added to Redis queue:", job.id);
    
    jobIds.push(job.id);
  }

  

  return { jobIds, skipped };
}