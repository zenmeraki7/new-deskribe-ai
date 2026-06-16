import type { Job } from "bullmq";

import { db } from "../../lib/db.server";
import { unauthenticated } from "../../shopify.server";
import { applyProduct, isRetryableError } from "./applyProduct";
import { isCancelled, markItem, markPendingItemsCancelled } from "./jobStatus";
import { acquireShopLock } from "./shopLock";
import { deriveFinalJobStatus, finalJobErrorMessage } from "./stateMachine";
import type {
  ApplyCounts,
  ApplyJobData,
  ApplyProductResult,
  GeneratedSeoOutputForApply,
} from "./types";
import { LIMITS } from "./types";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertValidPayload(data: ApplyJobData) {
  if (
    !data ||
    typeof data.applyId !== "string" ||
    typeof data.shopDomain !== "string" ||
    typeof data.jobId !== "string" ||
    !Array.isArray(data.productIds) ||
    data.productIds.length < 1 ||
    data.productIds.length > LIMITS.MAX_PRODUCTS
  ) {
    throw new Error("Invalid apply job payload");
  }

  const productIds = [...new Set(data.productIds)];

  for (const productId of productIds) {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
      throw new Error("Invalid product ID");
    }
  }

  return { ...data, productIds };
}

async function verifyInstalledShop(shopDomain: string) {
  const session = await db.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    select: { id: true },
  });

  if (!session) {
    throw new Error("Shop has no active offline session");
  }
}

function countResult(counts: ApplyCounts, result: ApplyProductResult) {
  if (result === "APPLIED") counts.applied += 1;
  else if (result === "SKIPPED") counts.skipped += 1;
  else if (result === "FAILED") counts.failed += 1;
  else if (result === "UNKNOWN") counts.unknown += 1;
}

export async function processApplyJob(bullJob: Job<ApplyJobData>) {
  const { applyId, shopDomain, jobId, productIds } = assertValidPayload(
    bullJob.data,
  );

  const releaseLock = await acquireShopLock(shopDomain, applyId);

  try {
    await verifyInstalledShop(shopDomain);

    const applyJob = await db.applyJob.findFirst({
      where: { id: applyId, shopDomain, jobId },
      select: { status: true },
    });

    if (!applyJob) throw new Error("Apply job record not found");

    if (applyJob.status === "CANCELLED") {
      return { ok: false, cancelled: true };
    }

    await db.applyJob.updateMany({
      where: {
        id: applyId,
        shopDomain,
        jobId,
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      data: {
        status: "PROCESSING",
        errorMessage: null,
      },
    });

    const { admin } = await unauthenticated.admin(shopDomain);

    const outputs = await db.generatedSeoOutput.findMany({
      where: {
        shopDomain,
        jobId,
        productId: { in: productIds },
        status: { in: ["READY", "APPLIED"] },
      },
      select: {
        id: true,
        productId: true,
        fields: true,
        sourceHash: true,
        status: true,
      },
    });

    const outputByProductId = new Map(
      outputs.map((output) => [
        output.productId,
        output as GeneratedSeoOutputForApply,
      ]),
    );

    const counts: ApplyCounts = {
      applied: 0,
      skipped: 0,
      failed: 0,
      unknown: 0,
      cancelled: false,
    };

    for (let index = 0; index < productIds.length; index++) {
      const productId = productIds[index];

      if (index % LIMITS.CANCEL_CHECK_INTERVAL === 0) {
        if (await isCancelled(applyId, shopDomain, jobId)) {
          counts.cancelled = true;
          break;
        }
      }

      const freshItem = await db.applyJobItem.findFirst({
        where: { shopDomain, applyId, jobId, productId },
        select: { status: true },
      });

      if (!freshItem) {
        counts.failed += 1;
        continue;
      }

      if (freshItem.status === "APPLIED") {
        counts.applied += 1;
        continue;
      }

      if (freshItem.status === "UNKNOWN") {
        counts.unknown += 1;
        continue;
      }

      const output = outputByProductId.get(productId);

      if (!output) {
        counts.failed += 1;

        await markItem({
          shopDomain,
          applyId,
          jobId,
          productId,
          status: "FAILED",
          errorMessage: "Generated output is not ready to apply.",
        });

        continue;
      }

      try {
        const result = await applyProduct({
          context: {
            shopDomain,
            applyId,
            jobId,
            adminGraphql: admin.graphql,
          },
          productId,
          output,
        });

        countResult(counts, result);
      } catch (error) {
        if (
          isRetryableError(error) &&
          bullJob.attemptsMade + 1 < (bullJob.opts.attempts ?? 1)
        ) {
          throw error;
        }

        counts.failed += 1;

        await db.$transaction([
          db.applyJobItem.updateMany({
            where: { shopDomain, applyId, jobId, productId },
            data: {
              status: "FAILED",
              errorMessage: "Apply failed.",
            },
          }),
          db.generatedSeoOutput.updateMany({
            where: {
              shopDomain,
              jobId,
              productId,
              status: "READY",
            },
            data: { status: "FAILED" },
          }),
        ]);
      }

      await sleep(LIMITS.PRODUCT_DELAY_MS);
    }

    if (counts.cancelled) {
      await markPendingItemsCancelled({ shopDomain, applyId, jobId });
    }

    await db.applyJob.updateMany({
      where: { id: applyId, shopDomain, jobId },
      data: {
        status: deriveFinalJobStatus(counts),
        errorMessage: finalJobErrorMessage(counts),
      },
    });

    return {
      ok: counts.failed === 0 && counts.unknown === 0 && !counts.cancelled,
      applied: counts.applied,
      skipped: counts.skipped,
      failed: counts.failed,
      unknown: counts.unknown,
    };
  } finally {
    await releaseLock();
  }
}
