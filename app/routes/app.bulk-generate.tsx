// FILE: app/routes/app.bulk-generate.tsx

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { authenticate } from "../shopify.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";
import { suggestKeywordsBulk } from "../lib/ai.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, refundCredits } from "../lib/creditService.server";

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

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session, billing } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // Resolve plan once — used by both intents
  const { appSubscriptions } = await billing.check();
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

  // ── Intent: suggest_keywords_bulk ─────────────────────────────────────────
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
      kind: "keyword_suggestion",
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

  // ── Intent: bulk_generate ─────────────────────────────────────────────────
  if (intent === "bulk_generate") {
    // ── Parse and validate productIds ────────────────────────────────────
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

    // ── Per-generation rate limit (counts as 1 call, not N) ──────────────
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

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}
