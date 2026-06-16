import crypto from "node:crypto";

import { db } from "../../lib/db.server";
import { logger } from "../../lib/logger.server";
import { computeProductHash } from "../../lib/productHash.server";
import { parseAndResanitizeSeoFields } from "../../lib/seoSanitizer.server";
import {
  adminGraphqlWithRetry,
  type AdminGraphql,
} from "../../lib/shopifyGraphql.server";
import { refundInvalidGeneratedOutput } from "./creditRefund";
import { markItem } from "./jobStatus";
import { fetchCurrentProductSeo, reconcileMutating } from "./reconcile";
import type {
  ApplyContext,
  ApplyProductResult,
  GeneratedSeoOutputForApply,
} from "./types";
import { LIMITS } from "./types";

export function clampError(error: unknown) {
  const raw =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return raw.slice(0, LIMITS.MAX_ERROR_CHARS);
}

export function fingerprint(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function buildProductInput(
  productId: string,
  fields: Record<string, unknown>,
) {
  const input: Record<string, unknown> = { id: productId };

  if (typeof fields.title === "string") input.title = fields.title;
  if (typeof fields.descriptionHtml === "string") {
    input.descriptionHtml = fields.descriptionHtml;
  }
  if (typeof fields.handle === "string") input.handle = fields.handle;
  if (Array.isArray(fields.tags)) input.tags = fields.tags;

  if (
    typeof fields.seoTitle === "string" ||
    typeof fields.seoDescription === "string"
  ) {
    input.seo = {
      ...(typeof fields.seoTitle === "string"
        ? { title: fields.seoTitle }
        : {}),
      ...(typeof fields.seoDescription === "string"
        ? { description: fields.seoDescription }
        : {}),
    };
  }

  return input;
}

async function updateProductSeo(
  adminGraphql: AdminGraphql,
  productId: string,
  fields: Record<string, unknown>,
) {
  const input = buildProductInput(productId, fields);

  if (Object.keys(input).length <= 1) {
    return { skipped: true as const };
  }

  const result = await adminGraphqlWithRetry<any>(
    adminGraphql,
    `#graphql
      mutation ApplyGeneratedSeo($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors {
            field
            message
          }
        }
      }`,
    { input },
  );

  const userErrors = result.data?.productUpdate?.userErrors ?? [];

  if (Array.isArray(userErrors) && userErrors.length > 0) {
    throw new Error("Shopify rejected product update");
  }

  return { skipped: false as const };
}

export async function applyProduct(args: {
  context: ApplyContext;
  productId: string;
  output: GeneratedSeoOutputForApply;
}): Promise<ApplyProductResult> {
  const { context, productId, output } = args;
  const { shopDomain, applyId, jobId, adminGraphql } = context;

  const currentItem = await db.applyJobItem.findFirst({
    where: { shopDomain, applyId, jobId, productId },
    select: {
      status: true,
    },
  });

  if (!currentItem) throw new Error("Apply job item not found");

  if (currentItem.status === "APPLIED") return "APPLIED";
  if (currentItem.status === "UNKNOWN") return "UNKNOWN";

  if (currentItem.status === "MUTATING") {
    const result = await reconcileMutating({
      context,
      productId,
    });

    if (result !== "RETRY") return result;
  }

  let fields: ReturnType<typeof parseAndResanitizeSeoFields>;

  try {
    fields = parseAndResanitizeSeoFields(output.fields);
  } catch (error) {
    await refundInvalidGeneratedOutput({
      shopDomain,
      applyId,
      jobId,
      productId,
      reason: "invalid-generated-output",
    });

    await db.$transaction([
      db.generatedSeoOutput.updateMany({
        where: {
          id: output.id,
          shopDomain,
          jobId,
          productId,
          status: "READY",
        },
        data: { status: "FAILED" },
      }),
      db.applyJobItem.updateMany({
        where: { shopDomain, applyId, jobId, productId },
        data: {
          status: "FAILED",
          errorMessage: "Generated output is invalid and was refunded.",
        },
      }),
    ]);

    logger.error("[apply.worker] invalid generated output refunded", {
      shopDomain,
      applyId,
      jobId,
      productId,
      errorMessage: clampError(error),
    });

    return "FAILED";
  }

  const writableInput = buildProductInput(productId, fields);

  if (Object.keys(writableInput).length <= 1) {
    await refundInvalidGeneratedOutput({
      shopDomain,
      applyId,
      jobId,
      productId,
      reason: "skipped-no-writable-fields",
    });

    await db.$transaction([
      db.generatedSeoOutput.updateMany({
        where: {
          id: output.id,
          shopDomain,
          jobId,
          productId,
          status: "READY",
        },
        data: { status: "SKIPPED" },
      }),
      db.applyJobItem.updateMany({
        where: { shopDomain, applyId, jobId, productId },
        data: {
          status: "SKIPPED",
          errorMessage: "No writable SEO fields were generated.",
        },
      }),
    ]);

    return "SKIPPED";
  }

  const current = await fetchCurrentProductSeo(adminGraphql, productId);

  if (!current) {
    await markItem({
      shopDomain,
      applyId,
      jobId,
      productId,
      status: "FAILED",
      errorMessage: "Product not found in Shopify.",
    });

    return "FAILED";
  }

  if (output.sourceHash && output.sourceHash !== computeProductHash(current)) {
    await markItem({
      shopDomain,
      applyId,
      jobId,
      productId,
      status: "FAILED",
      errorMessage:
        "Product changed after generation. Regenerate before applying.",
    });

    return "FAILED";
  }

  const snapshotId = crypto.randomUUID();
  const mutationFingerprint = fingerprint({ productId, fields });

  await db.$transaction([
    db.productMutationSnapshot.create({
      data: {
        id: snapshotId,
        shopDomain,
        jobId,
        applyId,
        productId,
        before: current,
        after: fields,
        status: "STARTED",
      },
    }),
    db.productSeoSnapshot.upsert({
      where: {
        shopDomain_applyId_productId: {
          shopDomain,
          applyId,
          productId,
        },
      },
      create: {
        shopDomain,
        jobId,
        applyId,
        productId,
        fields: current,
      },
      update: {},
    }),
    db.applyJobItem.updateMany({
      where: {
        shopDomain,
        applyId,
        jobId,
        productId,
        status: { notIn: ["APPLIED", "UNKNOWN", "CANCELLED"] },
      },
      data: {
        status: "MUTATING",
        errorMessage: null,
        mutationStartedAt: new Date(),
        mutationAttempt: { increment: 1 },
        mutationFingerprint,
      },
    }),
  ]);

  try {
    await updateProductSeo(adminGraphql, productId, fields);
  } catch (error) {
    await db.$transaction([
      db.productMutationSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: "FAILED",
          errorMessage: clampError(error),
        },
      }),
      db.applyJobItem.updateMany({
        where: { shopDomain, applyId, jobId, productId },
        data: {
          status: "PENDING",
          errorMessage: "Shopify update failed. Waiting for retry.",
        },
      }),
    ]);

    throw error;
  }

  const appliedAt = new Date();

  const applyJob = await db.applyJob.findFirst({
    where: { id: applyId, shopDomain, jobId },
    select: { requestedBy: true },
  });

  await db.$transaction([
    db.generatedSeoOutput.updateMany({
      where: {
        id: output.id,
        shopDomain,
        jobId,
        productId,
        status: "READY",
      },
      data: {
        status: "APPLIED",
        applyId,
        appliedAt,
        appliedBy: applyJob?.requestedBy ?? "shop",
      },
    }),
    db.applyJobItem.updateMany({
      where: { shopDomain, applyId, jobId, productId },
      data: {
        status: "APPLIED",
        appliedAt,
        mutationCompletedAt: appliedAt,
        errorMessage: null,
      },
    }),
    db.productMutationSnapshot.update({
      where: { id: snapshotId },
      data: {
        status: "SUCCEEDED",
        errorMessage: null,
      },
    }),
  ]);

  return "APPLIED";
}

export function isRetryableError(error: unknown) {
  const message = clampError(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("temporarily") ||
    message.includes("throttle") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("econnreset")
  );
}
