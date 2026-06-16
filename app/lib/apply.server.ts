import crypto from "node:crypto";

import { validateEnqueueApplyJob } from "../server/validation/serverLimits";
import { db } from "./db.server";
import { applyQueue } from "./queue.server";

const APPLY_QUEUE_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 16 * 60 * 1000,
  },
  removeOnComplete: 1000,
  removeOnFail: false,
} as const;

export type EnqueueApplyJobInput = {
  shopDomain: string;
  jobId: string;
  productIds: string[];
  applyId?: string;
  requestedBy?: string;
};

export type EnqueueApplyJobResult = {
  applyId: string;
  productIds: string[];
};

export function newApplyId() {
  return crypto.randomUUID();
}

export async function enqueueApplyJob(
  input: EnqueueApplyJobInput,
): Promise<EnqueueApplyJobResult> {
  const parsed = validateEnqueueApplyJob({
    jobId: input.jobId,
    applyId: input.applyId ?? newApplyId(),
    productIds: Array.from(new Set(input.productIds)),
  });

  const generationJob = await db.generationJob.findFirst({
    where: {
      id: parsed.jobId,
      shopDomain: input.shopDomain,
      status: "COMPLETED",
      productId: { in: parsed.productIds },
    },
    select: {
      id: true,
      productId: true,
      status: true,
    },
  });

  if (!generationJob) {
    throw new ApplyPreconditionError(
      "Generation job was not found, does not belong to this shop, or is not completed.",
      "APPLY_JOB_NOT_READY",
      404,
    );
  }

  const outputs = await db.generatedSeoOutput.findMany({
    where: {
      shopDomain: input.shopDomain,
      jobId: parsed.jobId,
      productId: { in: parsed.productIds },
      status: "READY",
    },
    select: {
      productId: true,
    },
  });

  if (outputs.length !== parsed.productIds.length) {
    const found = new Set(outputs.map((output) => output.productId));
    const missing = parsed.productIds.filter((productId) => !found.has(productId));
    throw new ApplyNotReadyError(missing);
  }

  const duplicateItems = await db.applyJobItem.findMany({
    where: {
      shopDomain: input.shopDomain,
      jobId: parsed.jobId,
      productId: { in: parsed.productIds },
      status: { in: ["QUEUED", "PROCESSING", "MUTATING", "APPLIED", "UNKNOWN"] },
    },
    select: {
      productId: true,
      status: true,
    },
  });

  if (duplicateItems.length > 0) {
    throw new ApplyPreconditionError(
      "One or more selected products already have an apply job or were already applied.",
      "APPLY_ALREADY_EXISTS",
      409,
    );
  }

  try {
    await db.applyJob.create({
      data: {
        id: parsed.applyId,
        shopDomain: input.shopDomain,
        jobId: parsed.jobId,
        status: "QUEUED",
        requestedBy: input.requestedBy ?? null,
        items: {
          create: outputs.map((output) => ({
            applyId: parsed.applyId,
            shopDomain: input.shopDomain,
            jobId: parsed.jobId,
            productId: output.productId,
            status: "QUEUED",
          })),
        },
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplyPreconditionError(
        "Apply job already exists for this request.",
        "APPLY_ALREADY_EXISTS",
        409,
      );
    }
    throw error;
  }

  try {
    await applyQueue.add(
      "apply",
      {
        shopDomain: input.shopDomain,
        jobId: parsed.jobId,
        applyId: parsed.applyId,
        productIds: parsed.productIds,
      },
      {
        ...APPLY_QUEUE_OPTIONS,
        jobId: `apply:${input.shopDomain}:${parsed.applyId}`,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Apply queue enqueue failed.";
    await db.applyJob.updateMany({
      where: {
        id: parsed.applyId,
        shopDomain: input.shopDomain,
        jobId: parsed.jobId,
      },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 2_000),
      },
    });
    await db.applyJobItem.updateMany({
      where: {
        shopDomain: input.shopDomain,
        jobId: parsed.jobId,
        applyId: parsed.applyId,
      },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 2_000),
      },
    });
    throw error;
  }

  return {
    applyId: parsed.applyId,
    productIds: parsed.productIds,
  };
}

export class ApplyNotReadyError extends Error {
  public readonly status = 409;
  public readonly code = "APPLY_OUTPUT_NOT_READY";
  public readonly missingProductIds: string[];

  constructor(missingProductIds: string[]) {
    super("Some selected products are not ready to apply.");
    this.name = "ApplyNotReadyError";
    this.missingProductIds = missingProductIds;
  }
}

export class ApplyPreconditionError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApplyPreconditionError";
    this.code = code;
    this.status = status;
  }
}

export function isApplyNotReadyError(error: unknown): error is ApplyNotReadyError {
  return error instanceof ApplyNotReadyError;
}

export function isApplyPreconditionError(error: unknown): error is ApplyPreconditionError {
  return error instanceof ApplyPreconditionError;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
