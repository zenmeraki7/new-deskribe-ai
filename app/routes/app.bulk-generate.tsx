// FILE: app/routes/app.bulk-generate.tsx

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { requireAdminSession } from "../lib/auth.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";
import {
  suggestKeywordsBulk,
  generateMetaOnly,
  generateImageAltTextBulk,
} from "../lib/ai.server";
import { checkBilling } from "../lib/billing.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import {
  CREDIT_COSTS,
  deductCredits,
  refundCredits,
} from "../lib/creditService.server";
import { getRedis } from "../../app/lib/redis.server";
import {
  PRODUCT_GID_RE,
  MEDIA_IMAGE_GID_RE,
  UUID_V4_RE,
} from "../routes/app.products.$productId.constants";
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

// -- Idempotency -----------------------------------------------------------------
// Claims an idempotency key for a given shop + operation. Returns "claimed" if
// this is the first time we've seen this key (caller should proceed), or
// "duplicate" if the key was already claimed (caller should short-circuit).
// TTL should comfortably cover realistic retry windows without blocking
// legitimate re-use of the same operation name far in the future.
async function claimIdempotencyKey(
  shopDomain: string,
  operation: string,
  idempotencyKey: string,
  ttlSeconds = 60 * 10,
): Promise<"claimed" | "duplicate"> {
  const redis = getRedis();
  const key = `idem:${shopDomain}:${operation}:${idempotencyKey}`;
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result ? "claimed" : "duplicate";
}

function readIdempotencyKey(fd: FormData): string | null {
  const raw = String(fd.get("idempotencyKey") ?? "");
  if (!raw || !UUID_V4_RE.test(raw)) return null;
  return raw;
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
    const idempotencyKey = readIdempotencyKey(fd);
    if (!idempotencyKey) {
      return json(
        {
          ok: false,
          error: "Missing or invalid idempotencyKey",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const claim = await claimIdempotencyKey(
      shopDomain,
      "suggest_keywords_bulk",
      idempotencyKey,
    );
    if (claim === "duplicate") {
      return json(
        { ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" },
        { status: 409 },
      );
    }

    const limitResult = await checkAndIncrementKeywordLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      return json(
        {
          ok: false,
          code:
            limitResult.reason === "global_limit"
              ? "GLOBAL_LIMIT_REACHED"
              : "RATE_LIMIT_EXCEEDED",
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
      metadata: {
        intent: "suggest_keywords_bulk",
        productCount: productIds.length,
      },
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
          metadata: {
            intent: "suggest_keywords_bulk",
            productCount: productIds.length,
          },
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
        metadata: {
          intent: "suggest_keywords_bulk",
          productCount: productIds.length,
        },
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
    const idempotencyKey = readIdempotencyKey(fd);
    if (!idempotencyKey) {
      return json(
        {
          ok: false,
          error: "Missing or invalid idempotencyKey",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const claim = await claimIdempotencyKey(
      shopDomain,
      "bulk_generate",
      idempotencyKey,
    );
    if (claim === "duplicate") {
      return json(
        { ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" },
        { status: 409 },
      );
    }

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
          metadata: {
            intent: "bulk_generate",
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
  // ── Intent: bulk_generate_meta ─────────────────────────────────────────
  if (intent === "bulk_generate_meta") {
    const idempotencyKey = readIdempotencyKey(fd);
    if (!idempotencyKey) {
      return json(
        {
          ok: false,
          error: "Missing or invalid idempotencyKey",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const metaClaim = await claimIdempotencyKey(
      shopDomain,
      "bulk_generate_meta",
      idempotencyKey,
    );
    if (metaClaim === "duplicate") {
      return json(
        { ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" },
        { status: 409 },
      );
    }

    let productIds: string[];
    try {
      const parsed = JSON.parse(String(fd.get("productIds") ?? "[]"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      productIds = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      return json(
        { ok: false, error: "Invalid productIds", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    if (productIds.length === 0 || productIds.length > 50) {
      return json(
        { ok: false, error: "Invalid product list", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

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
          {
            ok: false,
            code: "INSUFFICIENT_CREDITS",
            error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining,
            plan,
          },
          { status: 402 },
        );
      }

      const keywordsCsv = String(fd.get("keywords") ?? "");
      const keywords = normalizeKeywordList(keywordsCsv);

      const results: {
        productId: string;
        meta_title: string;
        meta_description: string;
      }[] = [];

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

      if (results.length === 0) {
        return json({
          ok: true,
          kind: "bulk_generate_meta",
          results: [],
          previewId: null,
        });
      }

      const redis = getRedis();
      const previewId = crypto.randomUUID();
      await redis.set(
        `bulk-meta-preview:${shopDomain}:${previewId}`,
        JSON.stringify(results),
        "EX",
        60 * 30,
      );

      return json({ ok: true, kind: "bulk_generate_meta", results, previewId });
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
      return json(
        { ok: false, error: message, code: "BULK_META_FAILED" },
        { status: 500 },
      );
    }
  }

  //  Intent: bulk_apply_meta
  if (intent === "bulk_apply_meta") {
    const idempotencyKey = readIdempotencyKey(fd);
    if (!idempotencyKey) {
      return json(
        {
          ok: false,
          error: "Missing or invalid idempotencyKey",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const applyMetaClaim = await claimIdempotencyKey(
      shopDomain,
      "bulk_apply_meta",
      idempotencyKey,
    );
    if (applyMetaClaim === "duplicate") {
      return json(
        { ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" },
        { status: 409 },
      );
    }

    const redis = getRedis();
    const previewId = String(fd.get("previewId") ?? "");
    const key = `bulk-meta-preview:${shopDomain}:${previewId}`;

    let items: {
      productId: string;
      meta_title: string;
      meta_description: string;
    }[];
    try {
      if (!previewId) {
        return json(
          {
            ok: false,
            error: "Missing previewId",
            code: "INVALID_INPUT",
          },
          { status: 400 },
        );
      }

      const stored = await redis.get(key);

      if (!stored) {
        return json(
          {
            ok: false,
            error: "Preview expired or invalid",
            code: "INVALID_PREVIEW",
          },
          { status: 404 },
        );
      }
      items = JSON.parse(stored);
    } catch {
      return json(
        { ok: false, error: "Invalid preview", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return json(
        { ok: false, error: "Invalid items list", code: "INVALID_INPUT" },
        { status: 400 },
      );
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
              ...(item.meta_description && {
                description: item.meta_description.slice(0, 320),
              }),
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
    await redis.del(key);

    return json({
      ok: true,
      kind: "bulk_apply_meta",
      succeeded,
      failed,
      total: items.length,
    });
  }

  // ── Intent: bulk_generate_alt_text ─────────────────────────────────────
 if (intent === "bulk_generate_alt_text") {
  const idempotencyKey = readIdempotencyKey(fd);
  if (!idempotencyKey) {
    return json({ ok: false, error: "Missing or invalid idempotencyKey", code: "INVALID_INPUT" }, { status: 400 });
  }
  const altClaim = await claimIdempotencyKey(shopDomain, "bulk_generate_alt_text", idempotencyKey);
  if (altClaim === "duplicate") {
    return json({ ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" }, { status: 409 });
  }

  let productIds: string[];
    try {
      const parsed = JSON.parse(String(fd.get("productIds") ?? "[]"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      productIds = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      return json(
        { ok: false, error: "Invalid productIds", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    if (productIds.length === 0 || productIds.length > 50) {
      return json(
        { ok: false, error: "Invalid product list", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const { appSubscriptions } = await checkBilling(admin.graphql);
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

    const productMetas = await Promise.all(
      productIds.map((id) =>
        fetchProductMeta(admin.graphql, id).catch(() => null),
      ),
    );

    const totalImages = productMetas.reduce(
      (sum, p) => sum + (p?.images.length ?? 0),
      0,
    );

    if (totalImages === 0) {
      return json({
        ok: true,
        kind: "bulk_generate_alt_text",
        results: [],
        previewId: null,
      });
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
          {
            ok: false,
            code: "INSUFFICIENT_CREDITS",
            error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining,
            plan,
          },
          { status: 402 },
        );
      }

      const results: { productId: string; imageId: string; altText: string }[] =
        [];
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

          product.images.forEach((img, i) => {
            results.push({
              productId: product.id,
              imageId: img.id,
              altText: altTexts[i] ?? "",
            });
          });

          processedImages += product.images.length;
        } catch (err) {
          console.error(
            `bulk_generate_alt_text: failed for ${product.id}`,
            err,
          );
        }
      }

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

      if (results.length === 0) {
        return json({
          ok: true,
          kind: "bulk_generate_alt_text",
          results: [],
          previewId: null,
        });
      }

      // Server owns the generated content from this point on — the client
      // only ever gets an opaque previewId back to reference it.
      const redis = getRedis();
      const previewId = crypto.randomUUID();
      await redis.set(
        `bulk-alt-preview:${shopDomain}:${previewId}`,
        JSON.stringify(results),
        "EX",
        60 * 30,
      );

      return json({
        ok: true,
        kind: "bulk_generate_alt_text",
        results,
        previewId,
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
      return json(
        { ok: false, error: message, code: "BULK_ALT_TEXT_FAILED" },
        { status: 500 },
      );
    }
  }

  // â”€â”€ Intent: bulk_apply_alt_text
  // ── Intent: bulk_apply_alt_text ────────────────────────────────────────
 if (intent === "bulk_apply_alt_text") {
    const idempotencyKey = readIdempotencyKey(fd);
    if (!idempotencyKey) {
      return json(
        { ok: false, error: "Missing or invalid idempotencyKey", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }
    const applyAltClaim = await claimIdempotencyKey(shopDomain, "bulk_apply_alt_text", idempotencyKey);
    if (applyAltClaim === "duplicate") {
      return json(
        { ok: false, error: "Duplicate request", code: "DUPLICATE_REQUEST" },
        { status: 409 },
      );
    }

    const previewId = String(fd.get("previewId") ?? "");

    if (!previewId) {
      return json(
        { ok: false, error: "Missing previewId", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const redis = getRedis();
    const key = `bulk-alt-preview:${shopDomain}:${previewId}`;

    let items: { productId: string; imageId: string; altText: string }[];
    try {
      const stored = await redis.get(key);
      if (!stored) {
        return json(
          {
            ok: false,
            error: "Preview expired or invalid",
            code: "INVALID_PREVIEW",
          },
          { status: 404 },
        );
      }
      items = JSON.parse(stored);
    } catch {
      return json(
        { ok: false, error: "Invalid preview", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
      return json(
        { ok: false, error: "Invalid items list", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const byProduct = new Map<string, { imageId: string; altText: string }[]>();
    for (const item of items) {
      if (
        !item ||
        typeof item.productId !== "string" ||
        typeof item.imageId !== "string" ||
        typeof item.altText !== "string" ||
        !PRODUCT_GID_RE.test(item.productId) ||
        !MEDIA_IMAGE_GID_RE.test(item.imageId)
      )
        continue;

      const existing = byProduct.get(item.productId) ?? [];
      existing.push({
        imageId: item.imageId,
        altText: stripHtml(item.altText.trim().slice(0, 512)),
      });
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
        }
      } catch (err) {
        console.error(`bulk_apply_alt_text: failed for ${productGid}`, err);
        failed += mediaItems.length;
      }
    }

    // Preview is single-use once applied.
    await redis.del(key);

    return json({
      ok: true,
      kind: "bulk_apply_alt_text",
      succeeded,
      failed,
      applied: succeeded,
      total: items.length,
    });
  }
  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}
