import { json } from "@remix-run/node";

import { reserveCredits } from "./creditReservation.server";
import { CREDIT_COSTS } from "./creditService.server";
import { db } from "./db.server";
import { enqueueGenerationJobs } from "./enqueue.server";
import { generationQueue } from "./queue.server";
import {
  checkRateLimit,
  incrementRateLimit,
  type Plan,
  type RateLimitResult,
} from "./rateLimiter.server";
import type { AdminGraphql } from "./shopifyGraphql.server";

export type BulkGenerateData = {
  productIds: string[];
  vibe: string;
  format: string;
  keywords: string;
  idempotencyKey: string;
};

const ESTIMATED_SECONDS_PER_JOB = 8;

async function getBulkResponseMetadata(shopDomain: string, jobIds: string[]) {
  try {
    const [queuedJobs, shopCredit] = await Promise.all([
      jobIds.length > 0
        ? generationQueue.getJobs(
            ["waiting", "delayed", "prioritized"],
            0,
            -1,
            true,
          )
        : Promise.resolve([]),
      db.shopCredit.findUnique({
        where: { shopId: shopDomain },
        select: { updatedAt: true },
      }),
    ]);
    const jobIdSet = new Set(jobIds);
    const queueIndex = queuedJobs.findIndex(
      (job) => typeof job.id === "string" && jobIdSet.has(job.id),
    );

    return {
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      estimatedCompletionSeconds: Math.max(
        ESTIMATED_SECONDS_PER_JOB,
        jobIds.length * ESTIMATED_SECONDS_PER_JOB,
      ),
      creditBalanceVersion: shopCredit?.updatedAt.getTime(),
    };
  } catch (error) {
    console.warn("[bulk-generate] response metadata unavailable:", error);
    return {
      queuePosition: null,
      estimatedCompletionSeconds: Math.max(
        ESTIMATED_SECONDS_PER_JOB,
        jobIds.length * ESTIMATED_SECONDS_PER_JOB,
      ),
    };
  }
}

function rateLimitResponse(limitResult: RateLimitResult) {
  const isGlobal = limitResult.reason === "global_limit";

  return json(
    {
      ok: false,
      code: isGlobal ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
      error: isGlobal
        ? "Service is temporarily at capacity. Please try again in a few hours."
        : "Too many generation requests. Please try again in a minute.",
    },
    { status: 429 },
  );
}

export async function bulkGenerateAction({
  data,
  shopDomain,
  adminGraphql,
  plan,
}: {
  data: BulkGenerateData;
  shopDomain: string;
  adminGraphql: AdminGraphql;
  plan: Plan;
}) {
  const { productIds, vibe, format, keywords, idempotencyKey } = data;
  const limitResult = await checkRateLimit(shopDomain, plan);

  if (!limitResult.allowed) {
    return rateLimitResponse(limitResult);
  }

  const creditAmount = productIds.length * CREDIT_COSTS.bulkProductGeneration;
  const creditRequestId = idempotencyKey;

  const reservation = await reserveCredits({
    shopId: shopDomain,
    plan,
    amount: creditAmount,
    requestId: idempotencyKey,
    kind: "bulk_generation",
    metadata: { operation: "bulk_generate", productCount: productIds.length },
  });

  if (!reservation.allowed) {
    return json(
      {
        ok: false,
        code: "INSUFFICIENT_CREDITS",
        error: "Not enough credits",
        creditsRemaining: reservation.creditsRemaining,
        creditsLimit: reservation.creditsLimit,
        resetDate: reservation.resetDate.toISOString(),
        plan,
      },
      { status: 402 },
    );
  }

  try {
    const { jobIds, skipped, deduplicated, bulkId } =
      await enqueueGenerationJobs({
        shopDomain,
        productIds,
        vibe,
        format,
        keywords,
        creditRequestId,
        creditCost: CREDIT_COSTS.bulkProductGeneration,
        adminGraphql,
      });

    if (deduplicated) {
      const refund = await reservation.rollback({
        suffix: "deduplicated",
        metadata: {
          operation: "bulk_generate",
          productCount: productIds.length,
        },
      });
      const responseMetadata = await getBulkResponseMetadata(
        shopDomain,
        jobIds,
      );

      return json({
        ok: true,
        jobIds,
        skipped,
        bulkId,
        alreadyQueued: true,
        creditsDeducted: 0,
        newBalance:
          "creditsRemaining" in refund
            ? refund.creditsRemaining
            : reservation.remainingAfterReservation,
        ...responseMetadata,
      });
    }

    if (jobIds.length === 0) {
      await reservation.rollback({
        suffix: "enqueue-empty",
        metadata: {
          operation: "bulk_generate",
          productCount: productIds.length,
        },
      });

      return json(
        {
          ok: false,
          error: "No products could be enqueued",
          code: "ALL_SKIPPED",
        },
        { status: 403 },
      );
    }

    await incrementRateLimit(shopDomain, plan).catch((error) => {
      console.warn("[bulk-generate] rate-limit increment skipped:", error);
    });

    let newBalance = reservation.remainingAfterReservation;
    const skippedCreditAmount =
      skipped.length * CREDIT_COSTS.bulkProductGeneration;

    if (skippedCreditAmount > 0) {
      const refund = await reservation.rollback({
        suffix: "skipped",
        amount: skippedCreditAmount,
        metadata: { operation: "bulk_generate", skippedCount: skipped.length },
      });

      if ("creditsRemaining" in refund) {
        newBalance = refund.creditsRemaining;
      }
    }
    const responseMetadata = await getBulkResponseMetadata(shopDomain, jobIds);

    return json({
      ok: true,
      jobIds,
      skipped,
      bulkId,
      creditsDeducted: jobIds.length * CREDIT_COSTS.bulkProductGeneration,
      newBalance,
      ...responseMetadata,
    });
  } catch (error: any) {
    await reservation.rollback({
      suffix: "enqueue-error",
      metadata: { operation: "bulk_generate", productCount: productIds.length },
    });

    console.error("[bulk-generate] enqueue error:", error);
    return json(
      {
        ok: false,
        code: "ENQUEUE_FAILED",
        error: error?.message ?? "Failed to enqueue jobs",
      },
      { status: 500 },
    );
  }
}
