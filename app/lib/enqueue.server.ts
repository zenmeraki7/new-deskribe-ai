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

// Add helper function to fetch product title
async function fetchProductTitle(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  productId: string
): Promise<string | null> {
  try {
    const response = await adminGraphql(
      `#graphql
      query GetProduct($id: ID!) {
        product(id: $id) {
          id
          title
        }
      }`,
      { variables: { id: productId } }
    );

    const data = await response.json();
    return data?.data?.product?.title || null;
  } catch (error) {
    console.error(`Failed to fetch product title for ${productId}:`, error);
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
  adminGraphql, // Now we'll use this!
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

    // Fetch product title before creating the job
    const productTitle = await fetchProductTitle(adminGraphql, productId);
    
    if (!productTitle) {
      console.warn(`Skipping product ${productId}: title not found`);
      skipped.push(productId);
      continue;
    }

    const job = await db.generationJob.create({
      data: {
        shopDomain,
        productId,
        productTitle, // ← Add the required field
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

    jobIds.push(job.id);
  }

  return { jobIds, skipped };
}