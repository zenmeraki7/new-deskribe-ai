import { db } from "../../lib/db.server";
import {
  computeProductHash,
  seoFieldsToSnapshot,
  type ProductSeoSnapshot,
} from "../../lib/productHash.server";
import {
  adminGraphqlWithRetry,
  type AdminGraphql,
} from "../../lib/shopifyGraphql.server";
import { markItem } from "./jobStatus";
import type { ApplyContext, ApplyProductResult } from "./types";
import { LIMITS } from "./types";

export async function fetchCurrentProductSeo(
  adminGraphql: AdminGraphql,
  productId: string,
): Promise<ProductSeoSnapshot | null> {
  const result = await adminGraphqlWithRetry<any>(
    adminGraphql,
    `#graphql
      query ProductSeoSnapshot($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          descriptionHtml
          tags
          seo {
            title
            description
          }
        }
      }`,
    { id: productId },
  );

  const product = result.data?.product;
  if (!product || product.id !== productId) return null;

  return {
    title: product.title ?? "",
    handle: product.handle ?? "",
    descriptionHtml: product.descriptionHtml ?? "",
    tags: Array.isArray(product.tags) ? product.tags : [],
    seoTitle: product.seo?.title ?? "",
    seoDescription: product.seo?.description ?? "",
  };
}

export async function reconcileMutating(args: {
  context: ApplyContext;
  productId: string;
}): Promise<ApplyProductResult | "RETRY"> {
  const { context, productId } = args;
  const { shopDomain, applyId, jobId, adminGraphql } = context;

  const item = await db.applyJobItem.findFirst({
    where: { shopDomain, applyId, jobId, productId },
    select: { mutationStartedAt: true },
  });

  const startedAt = item?.mutationStartedAt?.getTime() ?? 0;
  const stale = Date.now() - startedAt > LIMITS.MUTATING_STALE_MS;

  if (!stale) {
    return "IN_PROGRESS";
  }

  const [current, snapshot] = await Promise.all([
    fetchCurrentProductSeo(adminGraphql, productId),
    db.productMutationSnapshot.findFirst({
      where: {
        shopDomain,
        applyId,
        jobId,
        productId,
        status: "STARTED",
      },
      select: {
        id: true,
        after: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!current || !snapshot) {
    await markItem({
      shopDomain,
      applyId,
      jobId,
      productId,
      status: "UNKNOWN",
      errorMessage: "Could not reconcile stale Shopify mutation.",
    });

    return "UNKNOWN";
  }

  const fields =
    snapshot.after && typeof snapshot.after === "object"
      ? (snapshot.after as Record<string, unknown>)
      : {};
  const projected = seoFieldsToSnapshot(current, fields);

  if (computeProductHash(current) === computeProductHash(projected)) {
    const now = new Date();

    await db.$transaction([
      db.applyJobItem.updateMany({
        where: { shopDomain, applyId, jobId, productId },
        data: {
          status: "APPLIED",
          appliedAt: now,
          mutationCompletedAt: now,
          errorMessage: null,
        },
      }),
      db.productMutationSnapshot.update({
        where: { id: snapshot.id },
        data: { status: "SUCCEEDED", errorMessage: null },
      }),
    ]);

    return "APPLIED";
  }

  await markItem({
    shopDomain,
    applyId,
    jobId,
    productId,
    status: "PENDING",
    errorMessage:
      "Stale mutation did not match Shopify state. Reset for retry.",
  });

  return "RETRY";
}
