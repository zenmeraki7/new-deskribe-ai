import { db } from "../../lib/db.server";
import { refundCredits } from "../../lib/creditService.server";

export async function refundInvalidGeneratedOutput(args: {
  shopDomain: string;
  applyId: string;
  jobId: string;
  productId: string;
  reason: string;
}) {
  const job = await db.generationJob.findFirst({
    where: {
      id: args.jobId,
      shopDomain: args.shopDomain,
      productId: args.productId,
    },
    select: {
      creditRequestId: true,
      creditCost: true,
    },
  });

  if (!job?.creditRequestId || job.creditCost == null) return;

  const amount = Number(job.creditCost);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const requestId = [
    job.creditRequestId,
    args.applyId,
    args.jobId,
    args.productId,
    args.reason,
  ].join(":");

  const refund = await refundCredits({
    shopId: args.shopDomain,
    amount,
    requestId,
    metadata: {
      intent: "apply_invalid_generated_output",
      applyId: args.applyId,
      jobId: args.jobId,
      productId: args.productId,
      reason: args.reason,
    },
  });

  if (refund.refunded || refund.alreadyApplied) {
    await db.creditRefundLedger.upsert({
      where: {
        shopDomain_applyId_jobId_productId_reason: {
          shopDomain: args.shopDomain,
          applyId: args.applyId,
          jobId: args.jobId,
          productId: args.productId,
          reason: args.reason,
        },
      },
      create: {
        shopDomain: args.shopDomain,
        applyId: args.applyId,
        jobId: args.jobId,
        productId: args.productId,
        reason: args.reason,
        amount: Math.round(amount),
      },
      update: {},
    });
  }
}
