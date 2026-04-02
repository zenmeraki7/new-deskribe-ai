// FILE: app/features/products/product-editor.server.ts
import crypto from "node:crypto";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";

import { authenticate } from "../../shopify.server";
import { db } from "../../lib/db.server";
import { enqueueGenerationJobs } from "../../lib/enqueue.server";
import { suggestKeywords } from "../../lib/ai.server";
import { sanitiseHtml, stripHtml } from "../../lib/html.server";

import {
  ACTIVE_JOB_LOOKBACK_MS,
  ACTIVE_JOB_STATUSES,
  KEYWORDS,
  PRODUCT_GID_RE,
  SHOPIFY_GQL_RETRY,
  SHOPIFY_NUMERIC_ID_RE,
  UUID_V4_RE,
} from "../../routes/app.products.$productId.constants";
import type { LoaderData, ProductMeta, DraftResult } from "../../routes/app.products.$productId.types";
import { checkAndIncrementRateLimit, checkAndIncrementKeywordLimit, KEYWORD_LIMITS } from "../../lib/rateLimiter.server";
import { resolvePlan, type Plan } from "../../lib/rateLimiter.server";


// ─────────────────────────────────────────────────────────────────────────────
// Product ID handling (defensive)
// Supports route param being either numeric ID or full GID.
// ─────────────────────────────────────────────────────────────────────────────
async function getShopPlan(
  billing: Awaited<ReturnType<typeof authenticate.admin>>["billing"],
): Promise<Plan> {
  try {
    const { appSubscriptions } = await billing.check();
    const name = appSubscriptions?.[0]?.name ?? null;
    return resolvePlan(name);
  } catch {
    // Fail open to free — never block a user because billing check failed
    return "free";
  }
}


function normalizeProductGid(raw: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  if (PRODUCT_GID_RE.test(decoded)) return decoded;
  if (SHOPIFY_NUMERIC_ID_RE.test(decoded)) return `gid://shopify/Product/${decoded}`;
  return null;
}

function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

function nowIso() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword normalization (server-owned validation)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeKeywordList(input: unknown): string[] {
  const raw =
    typeof input === "string"
      ? input
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(input)
      ? input.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean)
      : [];

  const out: string[] = [];
  let total = 0;

  for (const k of raw) {
    const kw = k.slice(0, KEYWORDS.MAX_EACH_CHARS);
    if (!kw) continue;

    const lower = kw.toLowerCase();
    if (out.some((x) => x.toLowerCase() === lower)) continue;

    total += kw.length;
    if (out.length >= KEYWORDS.MAX) break;
    if (total > KEYWORDS.MAX_TOTAL_CHARS) break;

    out.push(kw);
  }

  return out;
}

function keywordCsvFromInput(input: unknown): string {
  return normalizeKeywordList(input).join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Strict DraftResult runtime validation (Zod) — no silent parse fallbacks
// ─────────────────────────────────────────────────────────────────────────────

const DraftResultSchema = z
  .object({
    body_html: z.string().optional(),
    meta_title: z.string().optional(),
    meta_description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    primary_keyword: z.string().optional(),
    headline: z.string().optional(),
    social_caption: z.string().optional(),
  })
  .strict();

function parseDraftResultOrNull(value: unknown): DraftResult | null {
  const res = DraftResultSchema.safeParse(value);
  if (!res.success) return null;
  const r = res.data;

  // Enforce keyword caps at the boundary (defense-in-depth)
  const cappedKeywords = r.keywords ? normalizeKeywordList(r.keywords) : undefined;

  return {
    ...r,
    keywords: cappedKeywords,
  } as DraftResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify GraphQL with retry/backoff + jitter (cost-aware, best-effort)
// - Retries transient HTTP failures and 429/5xx
// - Retries when Shopify reports throttling in errors or throttleStatus is low
// NOTE: For full platform-wide throttling, centralize in a shared Admin client wrapper.
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const ratio = 0.2; // ±20%
  const delta = ms * ratio;
  return Math.max(0, Math.floor(ms + (Math.random() * 2 - 1) * delta));
}

function isThrottleError(payload: any): boolean {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    for (const e of errors) {
      const msg = String(e?.message ?? "").toLowerCase();
      if (msg.includes("throttle") || msg.includes("throttled")) return true;
    }
  }

  const ts = payload?.extensions?.cost?.throttleStatus;
  // throttleStatus: { currentlyAvailable, maximumAvailable, restoreRate }
  // If currentlyAvailable is extremely low, treat as throttled and back off.
  if (
    ts &&
    typeof ts.currentlyAvailable === "number" &&
    typeof ts.maximumAvailable === "number" &&
    ts.maximumAvailable > 0
  ) {
    const ratio = ts.currentlyAvailable / ts.maximumAvailable;
    if (ratio < 0.05) return true;
  }

  return false;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function adminGraphqlWithRetry<T>(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  query: string,
  variables: Record<string, any>,
): Promise<T> {
  let attempt = 0;
  let delay = SHOPIFY_GQL_RETRY.BASE_DELAY_MS;

  while (attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) {
    attempt++;

    try {
      const resp = await adminGraphql(query, { variables });

      // Retry on transient HTTP errors (429/5xx)
      if (isRetryableHttpStatus(resp.status) && attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) {
        await sleep(jitter(Math.min(delay, SHOPIFY_GQL_RETRY.MAX_DELAY_MS)));
        delay *= 2;
        continue;
      }

      // Non-OK that isn't retryable: fail closed (surface error)
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }

      const payload = await resp.json();

      // Retry on throttle signals in payload
      if (isThrottleError(payload) && attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) {
        await sleep(jitter(Math.min(delay, SHOPIFY_GQL_RETRY.MAX_DELAY_MS)));
        delay *= 2;
        continue;
      }

      return payload as T;
    } catch (err) {
      if (attempt >= SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) throw err;
      await sleep(jitter(Math.min(delay, SHOPIFY_GQL_RETRY.MAX_DELAY_MS)));
      delay *= 2;
    }
  }

  throw new Error("Shopify GraphQL retry attempts exhausted");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify product meta fetch (server-owned; do not trust client form fields)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchProductMeta(adminGraphql: (query: string, opts?: any) => Promise<Response>, productGid: string) {
  const gql = await adminGraphqlWithRetry<{
    data?: { product?: ProductMeta | null };
    errors?: any[];
  }>(
    adminGraphql,
    `#graphql
    query ProductMeta($id: ID!) {
      product(id: $id) {
        id
        title
        productType
        vendor
        tags
      }
    }`,
    { id: productGid },
  );

  return gql.data?.product ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — metadata only; descriptionHtml fetched lazily
// All responses are shop-scoped via authenticate.admin(session.shop).
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const rawId = params.productId ?? "";
  const productGid = normalizeProductGid(rawId);
  if (!productGid) {
  throw new Response("Invalid product ID", { status: 400 });
}

  const product = await fetchProductMeta(admin.graphql, productGid);
if (!product) {
  throw new Response("Product not found", { status: 404 });
}

  const tenMinutesAgo = new Date(Date.now() - ACTIVE_JOB_LOOKBACK_MS);

  const activeJob = await db.generationJob.findFirst({
    where: {
      shopDomain,
      productId: productGid,
      status: { in: [...ACTIVE_JOB_STATUSES] as any },
      createdAt: { gte: tenMinutesAgo },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  const latestDraft = await db.generationJob.findFirst({
    where: {
      shopDomain,
      productId: productGid,
      status: "COMPLETED",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, createdAt: true },
  });

  // Policy warnings (keyword cannibalization check)
  const policyWarnings: string[] = [];
  if (latestDraft?.result) {
    const parsed = parseDraftResultOrNull(latestDraft.result);
    const pk = typeof parsed?.primary_keyword === "string" ? parsed.primary_keyword.trim() : "";
    if (pk) {
      // NOTE: This uses JSON path filtering; ensure Prisma/DB supports it in your environment.
      const conflict = await db.generationJob.findFirst({
        where: {
          shopDomain,
          status: "COMPLETED",
          productId: { not: productGid },
          result: { path: ["primary_keyword"], equals: pk },
        },
        select: { productId: true },
      });

      if (conflict) {
        policyWarnings.push(
          `Keyword "${pk}" is already used by another product — risk of SEO cannibalization.`,
        );
      }
    }
  }

  // IMPORTANT: sanitize *server-side* before sending to the client for preview.
  // Rendering itself is still sandboxed in the DiffViewer iframe (defense-in-depth).
  const sanitizedLatestDraft: LoaderData["latestDraft"] = latestDraft
    ? {
        id: latestDraft.id,
        createdAt: latestDraft.createdAt.toISOString(),
        result: (() => {
          const parsed = parseDraftResultOrNull(latestDraft.result);
          if (!parsed) return null;

          const body = typeof parsed.body_html === "string" ? sanitiseHtml(parsed.body_html) : undefined;
          const kw = parsed.keywords ? normalizeKeywordList(parsed.keywords) : undefined;

          return {
            ...parsed,
            body_html: body,
            keywords: kw,
          } as DraftResult;
        })(),
      }
    : null;

  return json<LoaderData>({
    product,
    descriptionHtml: null,
    activeJob: activeJob ? { id: activeJob.id, status: activeJob.status } : null,
    latestDraft: sanitizedLatestDraft,
    policyWarnings,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — generate | apply | suggest_keywords | fetch_description
// Security invariants:
// - Authenticated (authenticate.admin)
// - Shop-scoped DB access
// - Apply uses server-owned jobId + server-fetched result; never trusts client HTML
// - Sanitization happens server-side (allowlist sanitizer in html.server.ts)
// - Idempotency: generate uses deterministic matching against existing active job
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  const { admin, session, billing  } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const rawId = params.productId ?? "";
  const productGid = normalizeProductGid(rawId);
  if (!productGid) {
  throw new Response("Invalid product ID", { status: 400 });
}

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "generate") {

    const plan = await getShopPlan(billing);
    const limitResult = await checkAndIncrementRateLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      const isGlobal = limitResult.reason === "global_limit";
      return json(
        {
          ok: false,
          kind: "error",
          code: isGlobal ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
          error: isGlobal
            ? "Service is temporarily at capacity. Please try again in a few hours."
            : `Daily generation limit reached (${limitResult.shopUsed}/${limitResult.shopLimit}). ${
                plan === "free"
                  ? "Upgrade to Pro for 100 generations/day."
                  : "Limit resets at midnight UTC."
              }`,
          shopUsed: limitResult.shopUsed,
          shopLimit: limitResult.shopLimit,
          plan,
        },
        { status: 429 },
      );
    }
    
    const vibe = String(form.get("vibe") ?? "casual").slice(0, 40);
    const format = String(form.get("format") ?? "paragraph").slice(0, 40);
    const includeSocials = form.get("includeSocials") === "true";

    // Keywords must be bounded and normalized server-side.
    const keywordsCsv = keywordCsvFromInput(form.get("keywords"));

    // Idempotency (hard requirement) WITHOUT schema changes:
    // - If a matching job is already PENDING/PROCESSING recently, return it.
    // - Matching is deterministic on (shop, product, vibe, format, keywords, includeSocials) within lookback.
    const lookback = new Date(Date.now() - ACTIVE_JOB_LOOKBACK_MS);
    const existing = await db.generationJob.findFirst({
      where: {
        shopDomain,
        productId: productGid,
        status: { in: [...ACTIVE_JOB_STATUSES] as any },
        createdAt: { gte: lookback },
        vibe,
        format,
        keywords: keywordsCsv,
        includeSocials,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (existing) {
      return json({
        ok: true,
        kind: "generate",
        jobId: existing.id,
        status: "PENDING",
        alreadyQueued: true,
      });
    }

    try {
      const { jobIds, skipped } = await enqueueGenerationJobs({
        shopDomain,
        productIds: [productGid],
        vibe,
        format,
        keywords: keywordsCsv,
        includeSocials,
        adminGraphql: admin.graphql,
      });

      if (skipped.includes(productGid) || jobIds.length === 0) {
        return json(
          { ok: false, kind: "error", error: "Product not found or access denied", code: "NOT_FOUND_OR_DENIED" },
          { status: 403 },
        );
      }

      return json({ ok: true, kind: "generate", jobId: jobIds[0], status: "PENDING" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return json({ ok: false, kind: "error", error: message, code: "GENERATE_FAILED" }, { status: 500 });
    }
  }

  if (intent === "apply") {
    const jobId = String(form.get("jobId") ?? "");
    if (!jobId || !isUuidV4(jobId)) {
      return json({ ok: false, kind: "error", error: "Invalid jobId", code: "INVALID_JOB_ID" }, { status: 400 });
    }

    // Server fetches the draft — never trust client-provided HTML
    const job = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain, productId: productGid, status: "COMPLETED" },
      select: { result: true },
    });

    const parsed = job?.result ? parseDraftResultOrNull(job.result) : null;
    if (!parsed) {
      return json(
        { ok: false, kind: "error", error: "Draft not found or invalid", code: "DRAFT_NOT_FOUND" },
        { status: 404 },
      );
    }

    const rawHtml = typeof parsed.body_html === "string" ? parsed.body_html : "";
    // Final sanitize pass before writing to Shopify
    const cleanHtml = sanitiseHtml(rawHtml);

    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      mutation UpdateDescription($id: ID!, $descriptionHtml: String!) {
        productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml }) {
          product { id }
          userErrors { field message }
        }
      }`,
      { id: productGid, descriptionHtml: cleanHtml },
    );

    const userErrors = gql.data?.productUpdate?.userErrors ?? [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const msg = userErrors.map((e: { message: string }) => e.message).join("; ");
      return json({ ok: false, kind: "error", error: msg, code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }

    return json({ ok: true, kind: "apply", applied: true });
  }

  if (intent === "suggest_keywords") {
  try {
    const plan = await getShopPlan(billing);
    const limitResult = await checkAndIncrementKeywordLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      const isNotAllowed = limitResult.reason === "not_allowed";
      return json(
        {
          ok: false,
          kind: "error",
          code: "KEYWORD_LIMIT_EXCEEDED",
          error: isNotAllowed
            ? "Keyword suggestions are not available on the Free plan. Upgrade to Basic or higher."
            : `Daily keyword suggestion limit reached (${limitResult.used}/${limitResult.limit}). Resets at midnight UTC.`,
          plan,
          keywordUsed: limitResult.used,
          keywordLimit: limitResult.limit,
        },
        { status: 403 },
      );
    }

    const product = await fetchProductMeta(admin.graphql, productGid);
    if (!product) {
      throw new Response("Product not found", { status: 404 });
    }

    const keywords = await suggestKeywords(
      String(product.title ?? ""),
      String(product.vendor ?? ""),
      String(product.productType ?? ""),
      Array.isArray(product.tags)
        ? product.tags.filter((t) => typeof t === "string")
        : [],
    );

    // Cap returned keywords to plan limit
    const planLimit = KEYWORD_LIMITS[plan];
    const capCount = planLimit === Infinity ? 20 : planLimit;
    const safe = normalizeKeywordList(keywords).slice(0, capCount);

    return json({ ok: true, kind: "suggest_keywords", keywords: safe });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json(
      { ok: false, kind: "error", error: message, code: "SUGGEST_FAILED" },
      { status: 500 },
    );
  }
}
  

  if (intent === "fetch_description") {
    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      query ProductDesc($id: ID!) {
        product(id: $id) { descriptionHtml }
      }`,
      { id: productGid },
    );

    const descriptionHtml: string = String(gql.data?.product?.descriptionHtml ?? "");
    const sanitized = sanitiseHtml(descriptionHtml);

    return json({
      ok: true,
      kind: "fetch_description",
      descriptionHtml: sanitized,
      descriptionText: stripHtml(descriptionHtml),
      fetchedAt: nowIso(),
    });
  }

  return json({ ok: false, kind: "error", error: "Invalid intent", code: "INVALID_INTENT" }, { status: 400 });
}