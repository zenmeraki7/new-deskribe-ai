import crypto from "node:crypto";

import {
  ensureBulkOperation,
  reconcileBulkOperationStatus,
} from "./bulkOperation.server";
import { db } from "./db.server";
import {
  GENERATION_MAX_ATTEMPTS,
  GENERATION_RETRY_BASE_DELAY_MS,
} from "./generationJobStates";
import { generationQueue } from "./queue.server";
import type { AdminGraphql } from "./shopifyGraphql.server";

interface EnqueueParams {
  shopDomain: string;
  productIds: string[];
  vibe: string;
  format: string;
  keywords: string;
  customInstruction?: string;
  adminGraphql?: AdminGraphql;
  bulkId?: string;
  creditRequestId?: string;
  creditCost?: number;
}

export interface EnqueueResult {
  jobIds: string[];
  skipped: string[];
  deduplicated: boolean;
  bulkId: string | null;
}

function hashInput(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function generationRequestFingerprint(input: {
  productIds: string[];
  vibe: string;
  format: string;
  keywords: string;
  customInstruction?: string;
}) {
  const productIds = Array.from(new Set(input.productIds)).sort();
  const fields = [
    `customInstruction=${input.customInstruction ?? ""}`,
    `format=${input.format}`,
    `keywords=${input.keywords}`,
    `vibe=${input.vibe}`,
  ].sort();

  return hashInput(JSON.stringify({ productIds, fields }));
}

export async function enqueueGenerationJobs({
  shopDomain,
  productIds,
  vibe,
  format,
  keywords,
  bulkId: explicitBulkId,
  customInstruction = "",
  creditRequestId,
  creditCost,
}: EnqueueParams): Promise<EnqueueResult> {
  if (!shopDomain) {
    throw new Error("Missing shop context");
  }

  const normalizedProductIds = Array.from(new Set(productIds)).sort();
  if (normalizedProductIds.length === 0) {
    return { jobIds: [], skipped: [], deduplicated: false, bulkId: null };
  }

  const requestFingerprint = generationRequestFingerprint({
    productIds: normalizedProductIds,
    vibe,
    format,
    keywords,
    customInstruction,
  });
  const bulkId =
    explicitBulkId ??
    (normalizedProductIds.length > 1 ? crypto.randomUUID() : null);

  const findActiveRequest = async () => {
    const activeRows = await db.generationJob.findMany({
      where: {
        shopDomain,
        requestFingerprint,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, bulkId: true },
    });

    const activeBulkId = activeRows.find((job) => job.bulkId)?.bulkId;
    if (!activeBulkId) return activeRows;

    return db.generationJob.findMany({
      where: {
        shopDomain,
        requestFingerprint,
        bulkId: activeBulkId,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, bulkId: true },
    });
  };

  const activeRequest = await findActiveRequest();
  if (activeRequest.length > 0) {
    return {
      jobIds: activeRequest.map((job) => job.id),
      skipped: [],
      deduplicated: true,
      bulkId: activeRequest[0]?.bulkId ?? bulkId,
    };
  }

  await ensureBulkOperation({ bulkId, shopDomain });

  let jobs: Array<{ id: string; productId: string }>;
  try {
    jobs = await db.$transaction(
      normalizedProductIds.map((productId) =>
        db.generationJob.create({
          data: {
            shopDomain,
            productId,
            productTitle: productId,
            productVendor: "",
            productType: "",
            productTags: "",
            status: "PENDING",
            inputHash: hashInput(
              `${shopDomain}:${productId}:${vibe}:${format}:${keywords}:${customInstruction}`,
            ),
            requestFingerprint,
            vibe,
            format,
            keywords,
            isStale: false,
            cancelRequested: false,
            attempts: 0,
            maxAttempts: GENERATION_MAX_ATTEMPTS,
            nextRunAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastErrorCode: null,
            lastError: null,
            cancelledAt: null,
            completedAt: null,
            bulkId,
            customInstruction: customInstruction || null,
            creditRequestId: creditRequestId ?? null,
            creditCost: creditCost ?? null,
          },
          select: { id: true, productId: true },
        }),
      ),
    );
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const racedRequest = await findActiveRequest();
    if (racedRequest.length === 0) throw error;

    return {
      jobIds: racedRequest.map((job) => job.id),
      skipped: [],
      deduplicated: true,
      bulkId: racedRequest[0]?.bulkId ?? bulkId,
    };
  }

  await reconcileBulkOperationStatus({ bulkId, shopDomain });

  for (const job of jobs) {
    await generationQueue.add(
      `generate:${job.productId}`,
      {
        jobId: job.id,
        shopDomain,
        productId: job.productId,
        vibe,
        format,
        keywords,
        customInstruction: customInstruction || undefined,
        creditRequestId: creditRequestId ?? undefined,
        creditCost: creditCost ?? undefined,
      },
      {
        jobId: job.id,
        attempts: GENERATION_MAX_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: GENERATION_RETRY_BASE_DELAY_MS,
        },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    console.log(
      "[enqueue] Job added to Redis queue:",
      job.id,
      bulkId ? `(bulk: ${bulkId})` : "",
    );
  }

  return {
    jobIds: jobs.map((job) => job.id),
    skipped: [],
    deduplicated: false,
    bulkId,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
