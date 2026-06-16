import { db } from "./db.server";

export const BULK_OPERATION_ACTIVE_STATUSES = [
  "PENDING",
  "PROCESSING",
] as const;

export async function ensureBulkOperation({
  bulkId,
  shopDomain,
  status = "ACTIVE",
}: {
  bulkId: string | null | undefined;
  shopDomain: string;
  status?: string;
}) {
  if (!bulkId) return null;

  const existing = await db.bulkOperation.findUnique({
    where: { id: bulkId },
    select: { shopDomain: true },
  });

  if (existing) {
    if (existing.shopDomain !== shopDomain) {
      throw new Error("Bulk operation does not belong to this shop.");
    }

    return db.bulkOperation.update({
      where: { id: bulkId },
      data: { status },
    });
  }

  return db.bulkOperation.create({
    data: {
      id: bulkId,
      shopDomain,
      status,
    },
  });
}

export async function reconcileBulkOperationStatus({
  bulkId,
  shopDomain,
}: {
  bulkId: string | null | undefined;
  shopDomain: string;
}) {
  if (!bulkId) return null;

  const jobs = await db.generationJob.findMany({
    where: { bulkId, shopDomain },
    select: { status: true },
  });

  if (jobs.length === 0) {
    await db.bulkOperation.updateMany({
      where: { id: bulkId, shopDomain },
      data: { status: "EMPTY" },
    });
    return "EMPTY";
  }

  const statuses = jobs.map((job) => job.status);
  const status = summarizeBulkStatus(statuses);

  await db.bulkOperation.updateMany({
    where: { id: bulkId, shopDomain },
    data: { status },
  });

  return status;
}

export async function markBulkOperationActive({
  bulkId,
  shopDomain,
}: {
  bulkId: string | null | undefined;
  shopDomain: string;
}) {
  if (!bulkId) return;

  await db.bulkOperation.updateMany({
    where: { id: bulkId, shopDomain },
    data: { status: "ACTIVE" },
  });
}

export async function markBulkOperationCancelling({
  bulkId,
  shopDomain,
}: {
  bulkId: string | null | undefined;
  shopDomain: string;
}) {
  if (!bulkId) return;

  await db.bulkOperation.updateMany({
    where: { id: bulkId, shopDomain },
    data: { status: "CANCELLING" },
  });
}

function summarizeBulkStatus(statuses: string[]) {
  if (statuses.some((status) => status === "PENDING" || status === "PROCESSING")) {
    return "ACTIVE";
  }
  if (statuses.every((status) => status === "CANCELLED")) return "CANCELLED";
  if (statuses.every((status) => status === "COMPLETED")) return "COMPLETED";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  if (statuses.some((status) => status === "COMPLETED")) return "PARTIAL_COMPLETED";
  if (statuses.some((status) => status === "FAILED")) return "PARTIAL_FAILED";
  return "PARTIAL";
}
