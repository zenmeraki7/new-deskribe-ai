// FILE: app/routes/app.bulk-generate.tsx

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { requireAdminSession } from "../lib/auth.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";
import { suggestKeywordsBulk , generateMetaOnly, generateImageAltTextBulk } from "../lib/ai.server";
import { checkBilling } from "../lib/billing.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, refundCredits } from "../lib/creditService.server";
import { upsertAltTextDrafts, markAltTextApplied } from "../lib/altTextJob.server";
import { fetchProductMeta, PRODUCT_GID_RE, MEDIA_IMAGE_GID_RE } from "../lib/productMeta.server";
import { stripHtml } from "../lib/html.server";
import { normalizeKeywordList } from "../features/products/product-editor.server"; 

const MAX_BULK = 50;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function adminGraphqlWithRetry<T>(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  query: string,
  variables: Record<string, any>,
): Promise<T> {
  let attempt = 0;
  let delay = 500;
  const MAX_ATTEMPTS = 3;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const resp = await adminGraphql(query, { variables });

      if (
        (resp.status === 429 || resp.status >= 500) &&
        attempt < MAX_ATTEMPTS
      ) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Shopify GraphQL HTTP ${resp.status}: ${text.slice(0, 300)}`,
        );
      }

      return (await resp.json()) as T;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }

  throw new Error("Shopify GraphQL retry attempts exhausted");
}

// -- Action --------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  const { admin, shopDomain } = await requireAdminSession(request);

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // Resolve plan once â€” used by both intents
  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

  // -- Intent: suggest_keywords_bulk -----------------------------------------
  if (intent === "suggest_keywords_bulk") {
    const limitResult = await checkAndIncrementKeywordLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      return json(
        {
          ok: false,
          code: limitResult.reason === "global_limit" ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
          error:
            limitResult.reason === "global_limit"
              ? "Service is temporarily at capacity. Please try again in a few hours."
              : "Too many keyword requests. Please try again in a minute.",
          plan,
        },
        { status: 429 },
      );
    }

    const rawIds = String(fd.get("productIds") ?? "[]");
    let productIds: string[] = [];

    try {
      const parsed = JSON.parse(rawIds);
      if (Array.isArray(parsed)) {
        productIds = parsed
          .filter((id): id is string => typeof id === "string")
          .slice(0, 50);
      }
    } catch {
      return json(
        { ok: false, error: "Invalid productIds", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    if (productIds.length === 0) {
      return json({ ok: true, kind: "suggest_keywords_bulk", keywords: [] });
    }

    const creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.keywordSuggestion,
      requestId: creditRequestId,
      kind: "generation",
      metadata: { intent: "suggest_keywords_bulk", productCount: productIds.length },
    });

    if (!credit.allowed) {
      return json(
        {
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          error: "Not enough credits",
          creditsRemaining: credit.creditsRemaining,
          creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(),
          plan,
        },
        { status: 402 },
      );
    }

    try {
      const gql = await adminGraphqlWithRetry<any>(
        admin.graphql,
        `#graphql
        query ProductNodesMeta($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              vendor
              productType
              tags
            }
          }
        }`,
        { ids: productIds },
      );

      const nodes = (gql.data?.nodes ?? []) as Array<{
        id?: string;
        title?: string;
        vendor?: string;
        productType?: string;
        tags?: string[];
      } | null>;

      const productMetas = nodes
        .filter(
          (n): n is NonNullable<typeof n> =>
            n !== null && typeof n.title === "string",
        )
        .map((n) => ({
          title: String(n.title ?? ""),
          vendor: String(n.vendor ?? ""),
          productType: String(n.productType ?? ""),
          tags: Array.isArray(n.tags)
            ? n.tags.filter((t): t is string => typeof t === "string")
            : [],
        }));

      if (productMetas.length === 0) {
        await refundCredits({
          shopId: shopDomain,
          plan,
          amount: CREDIT_COSTS.keywordSuggestion,
          requestId: `${creditRequestId}:no-products`,
          metadata: { intent: "suggest_keywords_bulk", productCount: productIds.length },
        });
        return json({ ok: true, kind: "suggest_keywords_bulk", keywords: [] });
      }

      const keywords = await suggestKeywordsBulk(productMetas);

      const safe = keywords
        .filter((k) => typeof k === "string" && k.trim())
        .map((k) => k.trim().slice(0, 50))
        .slice(0, 20);

      return json({ ok: true, kind: "suggest_keywords_bulk", keywords: safe });
    } catch (err) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.keywordSuggestion,
        requestId: `${creditRequestId}:failed`,
        metadata: { intent: "suggest_keywords_bulk", productCount: productIds.length },
      });
      const message = err instanceof Error ? err.message : "Unknown error";
      return json(
        { ok: false, error: message, code: "SUGGEST_BULK_FAILED" },
        { status: 500 },
      );
    }
  }

  // -- Intent: bulk_generate -------------------------------------------------
  if (intent === "bulk_generate") {
    // -- Parse and validate productIds ------------------------------------
    let productIds: string[];
    try {
      const raw = fd.get("productIds");
      if (typeof raw !== "string") throw new Error("missing");
      productIds = JSON.parse(raw);
      if (!Array.isArray(productIds) || productIds.length === 0)
        throw new Error("empty");
      if (productIds.length > MAX_BULK)
        throw new Error(`max ${MAX_BULK} products per bulk request`);
      if (
        !productIds.every(
          (id) => typeof id === "string" && id.startsWith("gid://"),
        )
      )
        throw new Error("invalid product id format");
    } catch (e: any) {
      return json(
        { ok: false, error: `Invalid productIds: ${e.message}` },
        { status: 400 },
      );
    }

    // -- Per-generation rate limit (counts as 1 call, not N) --------------
    const limitResult = await checkAndIncrementRateLimit(shopDomain, plan);
    if (!limitResult.allowed) {
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

    const vibe = String(fd.get("vibe") ?? "casual").slice(0, 40);
    const format = String(fd.get("format") ?? "paragraph").slice(0, 40);
    const keywords = String(fd.get("keywords") ?? "").slice(0, 2000);
    const includeSocials = fd.get("includeSocials") === "true";
    const creditAmount = productIds.length * CREDIT_COSTS.bulkProductGeneration;
    const creditRequestId = crypto.randomUUID();

    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: creditAmount,
      requestId: creditRequestId,
      kind: "bulk_generation",
      metadata: { intent: "bulk_generate", productCount: productIds.length },
    });

    if (!credit.allowed) {
      return json(
        {
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          error: "Not enough credits",
          creditsRemaining: credit.creditsRemaining,
          creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(),
          plan,
        },
        { status: 402 },
      );
    }

    try {
      const { jobIds, skipped, bulkId } = await enqueueGenerationJobs({
        shopDomain,
        productIds,
        vibe,
        format,
        keywords,
        includeSocials,
        creditRequestId,
        creditCost: CREDIT_COSTS.bulkProductGeneration,
        adminGraphql: (query, opts) => admin.graphql(query, opts),
      });

       if (jobIds.length === 0) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: creditAmount,
        requestId: `${creditRequestId}:enqueue-empty`,
        metadata: { intent: "bulk_generate", productCount: productIds.length },
      });
      return json(
        { ok: false, error: "No products could be enqueued", code: "ALL_SKIPPED" },
        { status: 403 },
      );
    }

      if (skipped.length > 0) {
        await refundCredits({
          shopId: shopDomain,
          plan,
          amount: skipped.length * CREDIT_COSTS.bulkProductGeneration,
          requestId: `${creditRequestId}:skipped`,
          metadata: { intent: "bulk_generate", skippedCount: skipped.length },
        });
      }

      return json({ ok: true, jobIds, skipped, bulkId });
    } catch (err: any) {
    await refundCredits({
      shopId: shopDomain,
      plan,
      amount: creditAmount,
      requestId: `${creditRequestId}:enqueue-error`,
      metadata: { intent: "bulk_generate", productCount: productIds.length },
    });
    console.error("[bulk-generate] enqueue error:", err);
    return json(
      { ok: false, error: err?.message ?? "Failed to enqueue jobs" },
      { status: 500 },
    );
    }
  }
  // â”€â”€ Intent: bulk_generate_meta 
if (intent === "bulk_generate_meta") {
  let productIds: string[];
  try {
    productIds = JSON.parse(String(fd.get("productIds") ?? "[]"));
  } catch {
    return json({ ok: false, error: "Invalid productIds", code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!Array.isArray(productIds) || productIds.length === 0 || productIds.length > 50) {
    return json({ ok: false, error: "Invalid product list", code: "INVALID_INPUT" }, { status: 400 });
  }

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  const totalCost = CREDIT_COSTS.metaGeneration * productIds.length;
  let creditRequestId: string | null = null;

  try {
    creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: totalCost,
      requestId: creditRequestId,
      kind: "generation",
      metadata: { intent: "bulk_generate_meta", count: productIds.length },
    });

    if (!credit.allowed) {
      return json(
        { ok: false, code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
          creditsRemaining: credit.creditsRemaining, plan },
        { status: 402 },
      );
    }

    const keywordsCsv = String(fd.get("keywords") ?? "");
    const keywords = normalizeKeywordList(keywordsCsv);

    const results: { productId: string; meta_title: string; meta_description: string }[] = [];

    for (const productGid of productIds) {
      try {
        const product = await fetchProductMeta(admin.graphql, productGid);
        if (!product) continue;

        const meta = await generateMetaOnly({
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          tags: product.tags,
          keywords,
        });

        results.push({ productId: productGid, ...meta });
      } catch (err) {
        console.error(`bulk_generate_meta: failed for ${productGid}`, err);
      }
    }

    // Refund for any that failed
    const failedCount = productIds.length - results.length;
    if (failedCount > 0 && creditRequestId) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.metaGeneration * failedCount,
        requestId: `${creditRequestId}:partial-refund`,
        metadata: { intent: "bulk_generate_meta", failedCount },
      });
    }

    return json({ ok: true, kind: "bulk_generate_meta", results });
  } catch (err) {
    if (creditRequestId) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: totalCost,
        requestId: `${creditRequestId}:failed`,
        metadata: { intent: "bulk_generate_meta" },
      });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ ok: false, error: message, code: "BULK_META_FAILED" }, { status: 500 });
  }
}

// â”€â”€ Intent: bulk_apply_meta 
if (intent === "bulk_apply_meta") {
  let items: { productId: string; meta_title: string; meta_description: string }[];
  try {
    items = JSON.parse(String(fd.get("items") ?? "[]"));
  } catch {
    return json({ ok: false, error: "Invalid items", code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return json({ ok: false, error: "Invalid items list", code: "INVALID_INPUT" }, { status: 400 });
  }

  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== "string" ||
      !PRODUCT_GID_RE.test(item.productId)
    ) {
      failed++;
      continue;
    }

    try {
      const gql = await adminGraphqlWithRetry<any>(
        admin.graphql,
        `#graphql
        mutation UpdateMeta($id: ID!, $seo: SEOInput) {
          productUpdate(input: { id: $id, seo: $seo }) {
            product { id }
            userErrors { field message }
          }
        }`,
        {
          id: item.productId,
          seo: {
            ...(item.meta_title && { title: item.meta_title.slice(0, 70) }),
            ...(item.meta_description && { description: item.meta_description.slice(0, 320) }),
          },
        },
      );

      const userErrors = gql.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        failed++;
      } else {
        succeeded++;
      }
    } catch (err) {
      console.error(`bulk_apply_meta: failed for ${item.productId}`, err);
      failed++;
    }
  }

  return json({ ok: true, kind: "bulk_apply_meta", succeeded, failed, total: items.length });
}

// â”€â”€ Intent: bulk_generate_alt_text 
if (intent === "bulk_generate_alt_text") {
  let productIds: string[];
  try {
    productIds = JSON.parse(String(fd.get("productIds") ?? "[]"));
  } catch {
    return json({ ok: false, error: "Invalid productIds", code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!Array.isArray(productIds) || productIds.length === 0 || productIds.length > 50) {
    return json({ ok: false, error: "Invalid product list", code: "INVALID_INPUT" }, { status: 400 });
  }

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

  // Fetch all products first to know the total image count for credit deduction
  const productMetas = await Promise.all(
    productIds.map((id) => fetchProductMeta(admin.graphql, id).catch(() => null)),
  );

  const totalImages = productMetas.reduce(
    (sum, p) => sum + (p?.images.length ?? 0),
    0,
  );

  if (totalImages === 0) {
    return json({ ok: true, kind: "bulk_generate_alt_text", results: [] });
  }

  const totalCost = CREDIT_COSTS.altTextGeneration * totalImages;
  let creditRequestId: string | null = null;

  try {
    creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: totalCost,
      requestId: creditRequestId,
      kind: "generation",
      metadata: { intent: "bulk_generate_alt_text", totalImages },
    });

    if (!credit.allowed) {
      return json(
        { ok: false, code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
          creditsRemaining: credit.creditsRemaining, plan },
        { status: 402 },
      );
    }

    const sharedBulkId = crypto.randomUUID();
    const results: { productId: string; imageId: string; altText: string }[] = [];
    const jobIdByProduct = new Map<string, string>();
    let processedImages = 0;

    for (const product of productMetas) {
      if (!product || product.images.length === 0) continue;

      try {
        const altTexts = await generateImageAltTextBulk({
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          imageCount: product.images.length,
        });

        const entries = product.images.map((img, i) => ({ imageId: img.id, altText: altTexts[i] ?? "" }));

        const jobId = await upsertAltTextDrafts({
          shopDomain,
          productId: product.id,
          productTitle: product.title,
          entries,
          creditRequestId: creditRequestId!,
          creditCost: CREDIT_COSTS.altTextGeneration * entries.length,
          bulkId: sharedBulkId,
        });
        jobIdByProduct.set(product.id, jobId);

        for (const e of entries) results.push({ productId: product.id, ...e });
        processedImages += product.images.length;
      } catch (err) {
        console.error(`bulk_generate_alt_text: failed for ${product.id}`, err);
      }
    }

    // Refund for unprocessed images
    const unprocessed = totalImages - processedImages;
    if (unprocessed > 0 && creditRequestId) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.altTextGeneration * unprocessed,
        requestId: `${creditRequestId}:partial-refund`,
        metadata: { intent: "bulk_generate_alt_text", unprocessed },
      });
    }

    return json({
      ok: true,
      kind: "bulk_generate_alt_text",
      results,
      jobIds: Array.from(jobIdByProduct.values()),
      bulkId: sharedBulkId,
    });
  } catch (err) {
    if (creditRequestId) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: totalCost,
        requestId: `${creditRequestId}:failed`,
        metadata: { intent: "bulk_generate_alt_text" },
      });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ ok: false, error: message, code: "BULK_ALT_TEXT_FAILED" }, { status: 500 });
  }
}

// â”€â”€ Intent: bulk_apply_alt_text 
if (intent === "bulk_apply_alt_text") {
  let items: { productId: string; imageId: string; altText: string }[];
  try {
    items = JSON.parse(String(fd.get("items") ?? "[]"));
  } catch {
    return json({ ok: false, error: "Invalid items", code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    return json({ ok: false, error: "Invalid items list", code: "INVALID_INPUT" }, { status: 400 });
  }

  // Group by productId so we can batch per product
  const byProduct = new Map<string, { imageId: string; altText: string }[]>();
  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== "string" ||
      typeof item.imageId !== "string" ||
      typeof item.altText !== "string" ||
      !PRODUCT_GID_RE.test(item.productId) ||
      !MEDIA_IMAGE_GID_RE.test(item.imageId)
    ) continue;

    const existing = byProduct.get(item.productId) ?? [];
    existing.push({ imageId: item.imageId, altText: stripHtml(item.altText.trim().slice(0, 512)) });
    byProduct.set(item.productId, existing);
  }

  let succeeded = 0;
  let failed = 0;

  for (const [productGid, mediaItems] of byProduct.entries()) {
    try {
      const gql = await adminGraphqlWithRetry<any>(
        admin.graphql,
        `#graphql
        mutation UpdateImageAltBulk($productId: ID!, $media: [UpdateMediaInput!]!) {
          productUpdateMedia(productId: $productId, media: $media) {
            media { id alt }
            mediaUserErrors { field message }
          }
        }`,
        {
          productId: productGid,
          media: mediaItems.map((m) => ({ id: m.imageId, alt: m.altText })),
        },
      );

     const userErrors = gql.data?.productUpdateMedia?.mediaUserErrors ?? [];
if (userErrors.length > 0) {
  failed += mediaItems.length;
} else {
  succeeded += mediaItems.length;
  await markAltTextApplied({
    shopDomain,
    productId: productGid,
    imageIds: mediaItems.map((m) => m.imageId),
  });
}
    } catch (err) {
      console.error(`bulk_apply_alt_text: failed for ${productGid}`, err);
      failed += mediaItems.length;
    }
  }

  return json({ ok: true, kind: "bulk_apply_alt_text", succeeded, failed, applied: succeeded });
}
  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}
