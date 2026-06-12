// FILE: app/routes/app.bulk-generate.tsx

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";
import { suggestKeywordsBulk } from "../lib/ai.server";
import {
  resolvePlan,
  checkAndDeductCredits,
  refundCredits,
  CREDIT_COSTS,
} from "../lib/creditService.server";

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

    const cost = CREDIT_COSTS.keywordSuggestion;
    const limitResult = await checkAndDeductCredits(shopDomain, plan, cost);

    if (!limitResult.allowed) {
      return json(
        {
          ok: false,
          code: "CREDIT_LIMIT_EXCEEDED",
          error: `Insufficient credits. This requires ${cost} credits, but you only have ${Math.max(0, limitResult.limit - limitResult.used)} remaining.`,
          plan,
        },
        { status: 403 },
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
        return json({ ok: true, kind: "suggest_keywords_bulk", keywords: [] });
      }

      const keywords = await suggestKeywordsBulk(productMetas);

      const capCount = 20; // Just cap to 20 keywords

      const safe = keywords
        .filter((k) => typeof k === "string" && k.trim())
        .map((k) => k.trim().slice(0, 50))
      return json({ ok: true, kind: "suggest_keywords_bulk", keywords: safe });
    } catch (err) {
      await refundCredits(shopDomain, plan, cost);
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

    const cost = productIds.length * CREDIT_COSTS.bulkGeneration;
    const limitResult = await checkAndDeductCredits(shopDomain, plan, cost);
    if (!limitResult.allowed) {
      return json(
        {
          ok: false,
          code: "CREDITS_EXCEEDED",
          error: `Insufficient credits. This requires ${cost} credits, but you only have ${Math.max(0, limitResult.limit - limitResult.used)} remaining.`,
        },
        { status: 403 },
      );
    }

    const vibe = String(fd.get("vibe") ?? "casual").slice(0, 40);
    const format = String(fd.get("format") ?? "paragraph").slice(0, 40);
    const keywords = String(fd.get("keywords") ?? "").slice(0, 2000);
    const includeSocials = fd.get("includeSocials") === "true";

    try {
      const { jobIds, skipped, bulkId } = await enqueueGenerationJobs({
        shopDomain,
        productIds,
        vibe,
        format,
        keywords,
        includeSocials,
        adminGraphql: (query, opts) => admin.graphql(query, opts),
      });

       if (jobIds.length === 0) {
      await refundCredits(shopDomain, plan, cost);   // ← refund
      return json(
        { ok: false, error: "No products could be enqueued", code: "ALL_SKIPPED" },
        { status: 403 },
      );
    }

      return json({ ok: true, jobIds, skipped, bulkId });
    } catch (err: any) {
    await refundCredits(shopDomain, plan, cost);     // ← refund
    console.error("[bulk-generate] enqueue error:", err);
    return json(
      { ok: false, error: err?.message ?? "Failed to enqueue jobs" },
      { status: 500 },
    );
    }
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}
