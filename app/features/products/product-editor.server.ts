// FILE: app/features/products/product-editor.server.ts
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { z } from "zod";

import { db } from "../../lib/db.server";
import { requireAdminSession, type AdminAuthContext } from "../../lib/auth.server";
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
import { checkAndIncrementRateLimit, checkAndIncrementKeywordLimit } from "../../lib/rateLimiter.server";
import { resolvePlan, type Plan } from "../../lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, getCreditBalance, refundCredits } from "../../lib/creditService.server";


// ─────────────────────────────────────────────────────────────────────────────
// Product ID handling (defensive)
// Supports route param being either numeric ID or full GID.
// ─────────────────────────────────────────────────────────────────────────────
async function getShopPlan(
  billing: AdminAuthContext["billing"],
): Promise<Plan> {
  try {
    const { appSubscriptions } = await billing.check();
    const name = appSubscriptions?.[0]?.name ?? null;
    return resolvePlan(name);
  } catch {
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
// Strict DraftResult runtime validation (Zod)
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

  const cappedKeywords = r.keywords ? normalizeKeywordList(r.keywords) : undefined;

  return {
    ...r,
    keywords: cappedKeywords,
  } as DraftResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify GraphQL with retry/backoff + jitter
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const ratio = 0.2;
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

      if (isRetryableHttpStatus(resp.status) && attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) {
        await sleep(jitter(Math.min(delay, SHOPIFY_GQL_RETRY.MAX_DELAY_MS)));
        delay *= 2;
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }

      const payload = await resp.json();

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
// Shopify product meta fetch
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
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const { admin, billing, shopDomain } = await requireAdminSession(request);

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
    select: { id: true, result: true, createdAt: true, isStale: true },
  });

  // Policy warnings (keyword cannibalization check)
  const policyWarnings: string[] = [];
  if (latestDraft?.result) {
    const parsed = parseDraftResultOrNull(latestDraft.result);
    const pk = typeof parsed?.primary_keyword === "string" ? parsed.primary_keyword.trim() : "";
    if (pk) {
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

  const sanitizedLatestDraft: LoaderData["latestDraft"] = latestDraft
    ? {
        id: latestDraft.id,
        createdAt: latestDraft.createdAt.toISOString(),
         isStale: latestDraft.isStale,
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

  // ── Fetch shop plan ─────────────────────────────────────────────────────
  const shopPlan = await getShopPlan(billing);
  const credits = await getCreditBalance(shopDomain, shopPlan);

  // ── Fetch custom templates for this shop ────────────────────────────────
  const customTemplates = await db.customTemplate.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, name: true, instruction: true, createdAt: true },
  });

  return json<LoaderData>({
    product,
    descriptionHtml: null,
    activeJob: activeJob
  ? {
      id: activeJob.id,
      status: activeJob.status as LoaderData["activeJob"] extends infer T
        ? T extends { status: infer S }
          ? S
          : never
        : never,
    }
  : null,
    latestDraft: sanitizedLatestDraft,
    policyWarnings,
    shopPlan,
    credits: {
      creditsUsed: credits.creditsUsed,
      creditsLimit: credits.creditsLimit,
      creditsRemaining: credits.creditsRemaining,
      resetDate: credits.resetDate.toISOString(),
    },
    customTemplates: customTemplates.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  const { admin, billing, shopDomain } = await requireAdminSession(request);

  const rawId = params.productId ?? "";
  const productGid = normalizeProductGid(rawId);
  if (!productGid) {
    throw new Response("Invalid product ID", { status: 400 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── Intent: create_template ─────────────────────────────────────────────
   if (intent === "create_template") {
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    const instruction = String(form.get("instruction") ?? "").trim().slice(0, 1000);

    if (!name || !instruction) {
      return json(
        { ok: false, kind: "error", error: "Name and instruction are required", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    // ── Plan gate: custom templates require advanced or pro ──────────────
    const templatePlan = await getShopPlan(billing);
    if (templatePlan === "free" || templatePlan === "basic") {
      return json(
        {
          ok: false,
          kind: "error",
          error: "Custom writing styles require an Advanced or Pro plan. Upgrade to unlock this feature.",
          code: "PLAN_UPGRADE_REQUIRED",
          plan: templatePlan,
        },
        { status: 403 },
      );
    }

    const count = await db.customTemplate.count({ where: { shopDomain } });

    if (count >= 10) {
      return json(
        {
          ok: false,
          kind: "error",
          error: "Maximum 10 custom templates allowed. Delete one to add more.",
          code: "TEMPLATE_LIMIT",
        },
        { status: 400 },
      );
    }

    const template = await db.customTemplate.create({
      data: { shopDomain, name, instruction },
    });

    return json({
      ok: true,
      kind: "create_template",
      template: {
        id: template.id,
        name: template.name,
        instruction: template.instruction,
        createdAt: template.createdAt.toISOString(),
      },
    });
  }

  // ── Intent: delete_template ─────────────────────────────────────────────
  if (intent === "delete_template") {
    const templateId = String(form.get("templateId") ?? "").trim();
    if (!templateId) {
      return json(
        { ok: false, kind: "error", error: "Missing templateId", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    // ── Plan gate: only advanced/pro can manage custom templates ─────────
    const deletePlan = await getShopPlan(billing);
    if (deletePlan === "free" || deletePlan === "basic") {
      return json(
        {
          ok: false,
          kind: "error",
          error: "Custom writing styles require an Advanced or Pro plan.",
          code: "PLAN_UPGRADE_REQUIRED",
          plan: deletePlan,
        },
        { status: 403 },
      );
    }

    // shopDomain in where clause prevents deleting another shop's template
    await db.customTemplate.deleteMany({ where: { id: templateId, shopDomain } });
    return json({ ok: true, kind: "delete_template" });
  }

  // ── Intent: generate ────────────────────────────────────────────────────
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
            : "Too many generation requests. Please try again in a minute.",
          plan,
        },
        { status: 429 },
      );
    }

    const rawVibe = String(form.get("vibe") ?? "casual").slice(0, 40);
  const format = String(form.get("format") ?? "paragraph").slice(0, 40);
  const includeSocials = form.get("includeSocials") === "true";
  const keywordsCsv = keywordCsvFromInput(form.get("keywords"));

    // ── Custom template instruction ──────────────────────────────────────
    // When vibe starts with "custom:", the client sends the instruction text.
    // We sanitize it server-side: plain text only, no HTML.
    const customInstruction = String(form.get("customInstruction") ?? "")
    .trim()
    .slice(0, 1000);

    // Normalize vibe: strip "custom:" prefix for storage, use "custom" as the vibe value
    const vibe = rawVibe.startsWith("custom:") ? "custom" : rawVibe;

    // Idempotency: if a matching active job exists within lookback, return it
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
      customInstruction: customInstruction || null,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

    if (existing) {
      return json({
        ok: true,
        kind: "generate",
        jobId: existing.id,
        status: existing.status,
        alreadyQueued: true,
      });
    }

    const creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId,
      kind: "generation",
      metadata: { intent: "generate", productId: productGid },
    });

    if (!credit.allowed) {
      return json(
        {
          ok: false,
          kind: "error",
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
    const { jobIds, skipped } = await enqueueGenerationJobs({
      shopDomain,
      productIds: [productGid],
      vibe,
      format,
      keywords: keywordsCsv,
      includeSocials,
      customInstruction: customInstruction || undefined,
      creditRequestId,
      creditCost: CREDIT_COSTS.standardGeneration,
      adminGraphql: admin.graphql,
    });

    // Product wasn't found or access was denied — no job was created.
    if (skipped.includes(productGid) || jobIds.length === 0) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:enqueue-empty`,
        metadata: { intent: "generate", productId: productGid },
      });
      return json(
        { ok: false, kind: "error", error: "Product not found or access denied", code: "NOT_FOUND_OR_DENIED" },
        { status: 403 },
      );
    }

    return json({ ok: true, kind: "generate", jobId: jobIds[0], status: "PENDING" });

  } catch (err) {
    await refundCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: `${creditRequestId}:enqueue-error`,
      metadata: { intent: "generate", productId: productGid },
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    return json(
      { ok: false, kind: "error", error: message, code: "GENERATE_FAILED" },
      { status: 500 },
    );
  }
}

  // ── Intent: apply ────────────────────────────────────────────────────────
  if (intent === "apply") {
    const jobId = String(form.get("jobId") ?? "");
    if (!jobId || !isUuidV4(jobId)) {
      return json({ ok: false, kind: "error", error: "Invalid jobId", code: "INVALID_JOB_ID" }, { status: 400 });
    }

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
const cleanHtml = sanitiseHtml(rawHtml);

// SEO fields — Shopify enforces ~70 char title / ~320 char description limits
const seoTitle = typeof parsed.meta_title === "string"
  ? parsed.meta_title.slice(0, 70)
  : undefined;
const seoDescription = typeof parsed.meta_description === "string"
  ? parsed.meta_description.slice(0, 320)
  : undefined;

const gql = await adminGraphqlWithRetry<any>(
  admin.graphql,
  `#graphql
  mutation UpdateDescription($id: ID!, $descriptionHtml: String!, $seo: SEOInput) {
    productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml, seo: $seo }) {
      product { id }
      userErrors { field message }
    }
  }`,
  {
    id: productGid,
    descriptionHtml: cleanHtml,
    seo:
      seoTitle || seoDescription
        ? { title: seoTitle, description: seoDescription }
        : null,
  },
);

    const userErrors = gql.data?.productUpdate?.userErrors ?? [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const msg = userErrors.map((e: { message: string }) => e.message).join("; ");
      return json({ ok: false, kind: "error", error: msg, code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }

    return json({ ok: true, kind: "apply", applied: true });
  }

  // ── Intent: suggest_keywords ─────────────────────────────────────────────
  if (intent === "suggest_keywords") {
    let keywordCreditRequestId: string | null = null;
    let keywordPlan: Plan = "free";
    try {
      keywordPlan = await getShopPlan(billing);
      const limitResult = await checkAndIncrementKeywordLimit(shopDomain, keywordPlan);

      if (!limitResult.allowed) {
        return json(
          {
            ok: false,
            kind: "error",
            code: limitResult.reason === "global_limit" ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
            error:
              limitResult.reason === "global_limit"
                ? "Service is temporarily at capacity. Please try again in a few hours."
                : "Too many keyword requests. Please try again in a minute.",
            plan: keywordPlan,
          },
          { status: 429 },
        );
      }

      keywordCreditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: shopDomain,
        plan: keywordPlan,
        amount: CREDIT_COSTS.keywordSuggestion,
        requestId: keywordCreditRequestId,
        kind: "generation",
        metadata: { intent: "suggest_keywords", productId: productGid },
      });

      if (!credit.allowed) {
        return json(
          {
            ok: false,
            kind: "error",
            code: "INSUFFICIENT_CREDITS",
            error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining,
            creditsLimit: credit.creditsLimit,
            resetDate: credit.resetDate.toISOString(),
            plan: keywordPlan,
          },
          { status: 402 },
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

      const safe = normalizeKeywordList(keywords).slice(0, 20);

      return json({ ok: true, kind: "suggest_keywords", keywords: safe });
    } catch (err) {
      if (keywordCreditRequestId) {
        await refundCredits({
          shopId: shopDomain,
          plan: keywordPlan,
          amount: CREDIT_COSTS.keywordSuggestion,
          requestId: `${keywordCreditRequestId}:suggest-failed`,
          metadata: { intent: "suggest_keywords", productId: productGid },
        });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return json(
        { ok: false, kind: "error", error: message, code: "SUGGEST_FAILED" },
        { status: 500 },
      );
    }
  }

  // ── Intent: fetch_description ────────────────────────────────────────────
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
