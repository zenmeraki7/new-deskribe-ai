import { db } from "../../lib/db.server";
import type { ApplyItemStatus } from "./types";

export async function markItem(args: {
  shopDomain: string;
  applyId: string;
  jobId: string;
  productId: string;
  status: ApplyItemStatus;
  errorMessage?: string | null;
  data?: Record<string, unknown>;
}) {
  await db.applyJobItem.updateMany({
    where: {
      shopDomain: args.shopDomain,
      applyId: args.applyId,
      jobId: args.jobId,
      productId: args.productId,
    },
    data: {
      status: args.status,
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      ...(args.data ?? {}),
    },
  });
}

export async function isCancelled(
  applyId: string,
  shopDomain: string,
  jobId: string,
) {
  const applyJob = await db.applyJob.findFirst({
    where: { id: applyId, shopDomain, jobId },
    select: { status: true },
  });

  if (!applyJob) throw new Error("Apply job not found");

  return applyJob.status === "CANCELLED";
}

export async function markPendingItemsCancelled(args: {
  shopDomain: string;
  applyId: string;
  jobId: string;
}) {
  await db.applyJobItem.updateMany({
    where: {
      shopDomain: args.shopDomain,
      applyId: args.applyId,
      jobId: args.jobId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    data: {
      status: "CANCELLED",
      errorMessage: "Apply job was cancelled.",
    },
  });
}
