// FILE: app/features/products/product-editor.server.ts
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { z } from "zod";

import { db } from "../../lib/db.server";
import { requireAdminSession, type AdminAuthContext } from "../../lib/auth.server";
import { enqueueGenerationJobs } from "../../lib/enqueue.server";
import { suggestKeywords, generateImageAltText, generateImageAltTextBulk, generateMetaOnly } from "../../lib/ai.server";
import { checkBilling } from "../../lib/billing.server";
import { sanitiseHtml, stripHtml } from "../../lib/html.server";

import {
  ACTIVE_JOB_LOOKBACK_MS,
  ACTIVE_JOB_STATUSES,
  KEYWORDS,
  PRODUCT_GID_RE,
  SHOPIFY_GQL_RETRY,
  SHOPIFY_NUMERIC_ID_RE,
  UUID_V4_RE,
  MEDIA_IMAGE_GID_RE,
} from "../../routes/app.products.$productId.constants";
import type { LoaderData, ProductMeta, DraftResult } from "../../routes/app.products.$productId.types";
import { checkAndIncrementRateLimit, checkAndIncrementKeywordLimit } from "../../lib/rateLimiter.server";
import { resolvePlan, type Plan } from "../../lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, getCreditBalance, refundCredits } from "../../lib/creditService.server";
import { canUseFeature, PLAN_FEATURES, type CreditPlan } from "../../lib/credits";


// Helpers

async function getShopPlan(
  adminGraphql: AdminAuthContext["admin"]["graphql"],
): Promise<Plan> {
  try {
    const { appSubscriptions } = await checkBilling(adminGraphql);
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

function isValidMediaImageGid(s: string): boolean {
  return MEDIA_IMAGE_GID_RE.test(s);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeKeywordList(input: unknown): string[] {
  const raw =
    typeof input === "string"
      ? input.split(",").map((s) => s.trim()).filter(Boolean)
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


// Zod schema


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
  return { ...r, keywords: cappedKeywords } as DraftResult;
}


// GraphQL helpers


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
  if (ts && typeof ts.currentlyAvailable === "number" && typeof ts.maximumAvailable === "number" && ts.maximumAvailable > 0) {
    if (ts.currentlyAvailable / ts.maximumAvailable < 0.05) return true;
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


// Product meta fetch


async function fetchProductMeta(adminGraphql: (query: string, opts?: any) => Promise<Response>, productGid: string) {
  const gql = await adminGraphqlWithRetry<{
    data?: {
      product?: {
        id: string;
        title: string;
        productType: string;
        vendor: string;
        tags: string[];
        media?: { edges: { node: { id: string; alt: string | null; image?: { url: string } | null } }[] };
      } | null;
    };
    errors?: any[];
  }>(
    adminGraphql,
    `#graphql
    query ProductMeta($id: ID!) {
      product(id: $id) {
        id title productType vendor tags
        media(first: 50) {
          edges { node { id alt ... on MediaImage { image { url } } } }
        }
      }
    }`,
    { id: productGid },
  );

  const p = gql.data?.product;
  if (!p) return null;

  const images = (p.media?.edges ?? [])
    .map((e) => e.node)
    .filter((n) => n?.image?.url)
    .map((n) => ({ id: n.id, url: n.image!.url, altText: n.alt ?? null }));

  return { id: p.id, title: p.title, productType: p.productType, vendor: p.vendor, tags: p.tags, images };
}


// Loader


export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const { admin, shopDomain } = await requireAdminSession(request);

  const rawId = params.productId ?? "";
  const productGid = normalizeProductGid(rawId);
  if (!productGid) throw new Response("Invalid product ID", { status: 400 });

  const product = await fetchProductMeta(admin.graphql, productGid);
  if (!product) throw new Response("Product not found", { status: 404 });

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
    where: { shopDomain, productId: productGid, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, createdAt: true, isStale: true },
  });

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
        policyWarnings.push(`Keyword "${pk}" is already used by another product â€” risk of SEO cannibalization.`);
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
          return { ...parsed, body_html: body, keywords: kw } as DraftResult;
        })(),
      }
    : null;

  const shopPlan = await getShopPlan(admin.graphql);
  const credits = await getCreditBalance(shopDomain, shopPlan);

  const customTemplates = await db.customTemplate.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, name: true, instruction: true, createdAt: true },
  });

  
  const planFeatures = {
    altText: PLAN_FEATURES[shopPlan as CreditPlan]?.altText ?? false,
    metaGeneration: PLAN_FEATURES[shopPlan as CreditPlan]?.metaGeneration ?? false,
  };

  return json<LoaderData>({
    product,
    descriptionHtml: null,
    activeJob: activeJob
      ? {
          id: activeJob.id,
          status: activeJob.status as LoaderData["activeJob"] extends infer T
            ? T extends { status: infer S } ? S : never
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
    customTemplates: customTemplates.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    planFeatures,
  });
}


// Action

export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
  const { admin, shopDomain } = await requireAdminSession(request);

  const rawId = params.productId ?? "";
  const productGid = normalizeProductGid(rawId);
  if (!productGid) throw new Response("Invalid product ID", { status: 400 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // â”€â”€ Intent: create_template 
  if (intent === "create_template") {
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    const instruction = String(form.get("instruction") ?? "").trim().slice(0, 1000);

    if (!name || !instruction) {
      return json({ ok: false, kind: "error", error: "Name and instruction are required", code: "INVALID_INPUT" }, { status: 400 });
    }

    const templatePlan = await getShopPlan(admin.graphql);
    if (templatePlan === "free" || templatePlan === "basic") {
      return json(
        { ok: false, kind: "error", error: "Custom writing styles require an Advanced or Pro plan.", code: "PLAN_UPGRADE_REQUIRED", plan: templatePlan },
        { status: 403 },
      );
    }

    const count = await db.customTemplate.count({ where: { shopDomain } });
    if (count >= 10) {
      return json({ ok: false, kind: "error", error: "Maximum 10 custom templates allowed.", code: "TEMPLATE_LIMIT" }, { status: 400 });
    }

    const template = await db.customTemplate.create({ data: { shopDomain, name, instruction } });
    return json({
      ok: true,
      kind: "create_template",
      template: { id: template.id, name: template.name, instruction: template.instruction, createdAt: template.createdAt.toISOString() },
    });
  }

  // â”€â”€ Intent: delete_template 
  if (intent === "delete_template") {
    const templateId = String(form.get("templateId") ?? "").trim();
    if (!templateId) {
      return json({ ok: false, kind: "error", error: "Missing templateId", code: "INVALID_INPUT" }, { status: 400 });
    }

    const deletePlan = await getShopPlan(admin.graphql);
    if (deletePlan === "free" || deletePlan === "basic") {
      return json(
        { ok: false, kind: "error", error: "Custom writing styles require an Advanced or Pro plan.", code: "PLAN_UPGRADE_REQUIRED", plan: deletePlan },
        { status: 403 },
      );
    }

    await db.customTemplate.deleteMany({ where: { id: templateId, shopDomain } });
    return json({ ok: true, kind: "delete_template" });
  }

  // â”€â”€ Intent: generate 
  if (intent === "generate") {
    const plan = await getShopPlan(admin.graphql);
    const limitResult = await checkAndIncrementRateLimit(shopDomain, plan);

    if (!limitResult.allowed) {
      const isGlobal = limitResult.reason === "global_limit";
      return json(
        {
          ok: false, kind: "error",
          code: isGlobal ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
          error: isGlobal ? "Service is temporarily at capacity." : "Too many generation requests. Please try again in a minute.",
          plan,
        },
        { status: 429 },
      );
    }

    const rawVibe = String(form.get("vibe") ?? "casual").slice(0, 40);
    const format = String(form.get("format") ?? "paragraph").slice(0, 40);
    const includeSocials = form.get("includeSocials") === "true";
    const keywordsCsv = keywordCsvFromInput(form.get("keywords"));
    const customInstruction = String(form.get("customInstruction") ?? "").trim().slice(0, 1000);
    const vibe = rawVibe.startsWith("custom:") ? "custom" : rawVibe;

    const lookback = new Date(Date.now() - ACTIVE_JOB_LOOKBACK_MS);
    const existing = await db.generationJob.findFirst({
      where: {
        shopDomain, productId: productGid,
        status: { in: [...ACTIVE_JOB_STATUSES] as any },
        createdAt: { gte: lookback },
        vibe, format, keywords: keywordsCsv, includeSocials,
        customInstruction: customInstruction || null,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (existing) {
      return json({ ok: true, kind: "generate", jobId: existing.id, status: existing.status, alreadyQueued: true });
    }

    const creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain, plan, amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId, kind: "generation",
      metadata: { intent: "generate", productId: productGid },
    });

    if (!credit.allowed) {
      return json(
        { ok: false, kind: "error", code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
          creditsRemaining: credit.creditsRemaining, creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(), plan },
        { status: 402 },
      );
    }

    try {
      const { jobIds, skipped } = await enqueueGenerationJobs({
        shopDomain, productIds: [productGid], vibe, format, keywords: keywordsCsv,
        includeSocials, customInstruction: customInstruction || undefined,
        creditRequestId, creditCost: CREDIT_COSTS.standardGeneration, adminGraphql: admin.graphql,
      });

      if (skipped.includes(productGid) || jobIds.length === 0) {
        await refundCredits({
          shopId: shopDomain, plan, amount: CREDIT_COSTS.standardGeneration,
          requestId: `${creditRequestId}:enqueue-empty`,
          metadata: { intent: "generate", productId: productGid },
        });
        return json({ ok: false, kind: "error", error: "Product not found or access denied", code: "NOT_FOUND_OR_DENIED" }, { status: 403 });
      }

      return json({ ok: true, kind: "generate", jobId: jobIds[0], status: "PENDING" });
    } catch (err) {
      await refundCredits({
        shopId: shopDomain, plan, amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:enqueue-error`,
        metadata: { intent: "generate", productId: productGid },
      });
      const message = err instanceof Error ? err.message : "Unknown error";
      return json({ ok: false, kind: "error", error: message, code: "GENERATE_FAILED" }, { status: 500 });
    }
  }

  // â”€â”€ Intent: apply 
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
      return json({ ok: false, kind: "error", error: "Draft not found or invalid", code: "DRAFT_NOT_FOUND" }, { status: 404 });
    }

    const rawHtml = typeof parsed.body_html === "string" ? parsed.body_html : "";
    const cleanHtml = sanitiseHtml(rawHtml);
    const seoTitle = typeof parsed.meta_title === "string" ? parsed.meta_title.slice(0, 70) : undefined;
    const seoDescription = typeof parsed.meta_description === "string" ? parsed.meta_description.slice(0, 320) : undefined;

    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      mutation UpdateDescription($id: ID!, $descriptionHtml: String!, $seo: SEOInput) {
        productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml, seo: $seo }) {
          product { id }
          userErrors { field message }
        }
      }`,
      { id: productGid, descriptionHtml: cleanHtml, seo: seoTitle || seoDescription ? { title: seoTitle, description: seoDescription } : null },
    );

    const userErrors = gql.data?.productUpdate?.userErrors ?? [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const msg = userErrors.map((e: { message: string }) => e.message).join("; ");
      return json({ ok: false, kind: "error", error: msg, code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }

    return json({ ok: true, kind: "apply", applied: true });
  }

  // â”€â”€ Intent: suggest_keywords 
  if (intent === "suggest_keywords") {
    let keywordCreditRequestId: string | null = null;
    let keywordPlan: Plan = "free";
    try {
      keywordPlan = await getShopPlan(admin.graphql);
      const limitResult = await checkAndIncrementKeywordLimit(shopDomain, keywordPlan);

      if (!limitResult.allowed) {
        return json(
          {
            ok: false, kind: "error",
            code: limitResult.reason === "global_limit" ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
            error: limitResult.reason === "global_limit" ? "Service is temporarily at capacity." : "Too many keyword requests.",
            plan: keywordPlan,
          },
          { status: 429 },
        );
      }

      keywordCreditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: shopDomain, plan: keywordPlan, amount: CREDIT_COSTS.keywordSuggestion,
        requestId: keywordCreditRequestId, kind: "generation",
        metadata: { intent: "suggest_keywords", productId: productGid },
      });

      if (!credit.allowed) {
        return json(
          { ok: false, kind: "error", code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining, creditsLimit: credit.creditsLimit,
            resetDate: credit.resetDate.toISOString(), plan: keywordPlan },
          { status: 402 },
        );
      }

      const product = await fetchProductMeta(admin.graphql, productGid);
      if (!product) throw new Response("Product not found", { status: 404 });

      const keywords = await suggestKeywords(
        String(product.title ?? ""), String(product.vendor ?? ""), String(product.productType ?? ""),
        Array.isArray(product.tags) ? product.tags.filter((t) => typeof t === "string") : [],
      );

      return json({ ok: true, kind: "suggest_keywords", keywords: normalizeKeywordList(keywords).slice(0, 20) });
    } catch (err) {
      if (keywordCreditRequestId) {
        await refundCredits({
          shopId: shopDomain, plan: keywordPlan, amount: CREDIT_COSTS.keywordSuggestion,
          requestId: `${keywordCreditRequestId}:suggest-failed`,
          metadata: { intent: "suggest_keywords", productId: productGid },
        });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return json({ ok: false, kind: "error", error: message, code: "SUGGEST_FAILED" }, { status: 500 });
    }
  }

  // â”€â”€ Intent: fetch_description 
  if (intent === "fetch_description") {
    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql query ProductDesc($id: ID!) { product(id: $id) { descriptionHtml } }`,
      { id: productGid },
    );
    const descriptionHtml: string = String(gql.data?.product?.descriptionHtml ?? "");
    const sanitized = sanitiseHtml(descriptionHtml);
    return json({ ok: true, kind: "fetch_description", descriptionHtml: sanitized, descriptionText: stripHtml(descriptionHtml), fetchedAt: nowIso() });
  }

  // â”€â”€ Intent: generate_alt_text 
  if (intent === "generate_alt_text") {
    const plan = await getShopPlan(admin.graphql);

    if (!canUseFeature(plan, "altText")) {
      return json(
        { ok: false, kind: "error", error: "Image alt text generation requires a Basic plan or higher.", code: "PLAN_UPGRADE_REQUIRED", plan },
        { status: 403 },
      );
    }

    const imageId = String(form.get("imageId") ?? "");
    const imageIndex = Number(form.get("imageIndex") ?? 0);
    const totalImages = Number(form.get("totalImages") ?? 1);

    if (!isValidMediaImageGid(imageId)) {
      return json({ ok: false, kind: "error", error: "Invalid image ID", code: "INVALID_IMAGE_ID" }, { status: 400 });
    }
    if (!Number.isFinite(imageIndex) || imageIndex < 0 || !Number.isFinite(totalImages) || totalImages < 1) {
      return json({ ok: false, kind: "error", error: "Invalid image position", code: "INVALID_INPUT" }, { status: 400 });
    }

    let creditRequestId: string | null = null;
    try {
      creditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: shopDomain, plan, amount: CREDIT_COSTS.altTextGeneration,
        requestId: creditRequestId, kind: "generation",
        metadata: { intent: "generate_alt_text", productId: productGid, imageId },
      });

      if (!credit.allowed) {
        return json(
          { ok: false, kind: "error", code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining, creditsLimit: credit.creditsLimit,
            resetDate: credit.resetDate.toISOString(), plan },
          { status: 402 },
        );
      }

      const product = await fetchProductMeta(admin.graphql, productGid);
      if (!product) throw new Response("Product not found", { status: 404 });

      const altText = await generateImageAltText({ title: product.title, vendor: product.vendor, productType: product.productType, imageIndex, totalImages });
      return json({ ok: true, kind: "generate_alt_text", imageId, altText });
    } catch (err) {
      if (creditRequestId) {
        await refundCredits({
          shopId: shopDomain, plan, amount: CREDIT_COSTS.altTextGeneration,
          requestId: `${creditRequestId}:alt-text-failed`,
          metadata: { intent: "generate_alt_text", productId: productGid, imageId },
        });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return json({ ok: false, kind: "error", error: message, code: "ALT_TEXT_FAILED" }, { status: 500 });
    }
  }

  // â”€â”€ Intent: generate_alt_text_bulk 
  if (intent === "generate_alt_text_bulk") {
    const plan = await getShopPlan(admin.graphql);

    if (!canUseFeature(plan, "altText")) {
      return json(
        { ok: false, kind: "error", error: "Image alt text generation requires a Basic plan or higher.", code: "PLAN_UPGRADE_REQUIRED", plan },
        { status: 403 },
      );
    }

    let imageIds: string[];
    try {
      imageIds = JSON.parse(String(form.get("imageIds") ?? "[]"));
    } catch {
      return json({ ok: false, kind: "error", error: "Invalid imageIds", code: "INVALID_INPUT" }, { status: 400 });
    }

    if (!Array.isArray(imageIds) || imageIds.length === 0 || imageIds.length > 50) {
      return json({ ok: false, kind: "error", error: "Invalid image list", code: "INVALID_INPUT" }, { status: 400 });
    }
    if (!imageIds.every((id) => typeof id === "string" && isValidMediaImageGid(id))) {
      return json({ ok: false, kind: "error", error: "Invalid image ID in list", code: "INVALID_IMAGE_ID" }, { status: 400 });
    }

    const totalCost = CREDIT_COSTS.altTextGeneration * imageIds.length;
    let creditRequestId: string | null = null;
    try {
      creditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: shopDomain, plan, amount: totalCost,
        requestId: creditRequestId, kind: "generation",
        metadata: { intent: "generate_alt_text_bulk", productId: productGid, count: imageIds.length },
      });

      if (!credit.allowed) {
        return json(
          { ok: false, kind: "error", code: "INSUFFICIENT_CREDITS", error: "Not enough credits",
            creditsRemaining: credit.creditsRemaining, creditsLimit: credit.creditsLimit,
            resetDate: credit.resetDate.toISOString(), plan },
          { status: 402 },
        );
      }

      const product = await fetchProductMeta(admin.graphql, productGid);
      if (!product) throw new Response("Product not found", { status: 404 });

      const altTexts = await generateImageAltTextBulk({ title: product.title, vendor: product.vendor, productType: product.productType, imageCount: imageIds.length });
      const results = imageIds.map((imageId, i) => ({ imageId, altText: altTexts[i] ?? "" }));
      return json({ ok: true, kind: "generate_alt_text_bulk", results });
    } catch (err) {
      if (creditRequestId) {
        await refundCredits({
          shopId: shopDomain, plan, amount: totalCost,
          requestId: `${creditRequestId}:alt-text-bulk-failed`,
          metadata: { intent: "generate_alt_text_bulk", productId: productGid },
        });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return json({ ok: false, kind: "error", error: message, code: "ALT_TEXT_BULK_FAILED" }, { status: 500 });
    }
  }

  // â”€â”€ Intent: apply_alt_text 
  if (intent === "apply_alt_text") {
    const plan = await getShopPlan(admin.graphql);
    if (!canUseFeature(plan, "altText")) {
      return json({ ok: false, kind: "error", error: "Upgrade required.", code: "PLAN_UPGRADE_REQUIRED", plan }, { status: 403 });
    }

    const imageId = String(form.get("imageId") ?? "");
    const altText = String(form.get("altText") ?? "").trim().slice(0, 512);

    if (!isValidMediaImageGid(imageId)) {
      return json({ ok: false, kind: "error", error: "Invalid image ID", code: "INVALID_IMAGE_ID" }, { status: 400 });
    }
    if (!altText) {
      return json({ ok: false, kind: "error", error: "Alt text cannot be empty", code: "INVALID_INPUT" }, { status: 400 });
    }

    const cleanAlt = stripHtml(altText);
    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      mutation UpdateImageAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { id alt }
          mediaUserErrors { field message }
        }
      }`,
      { productId: productGid, media: [{ id: imageId, alt: cleanAlt }] },
    );

    const userErrors = gql.data?.productUpdateMedia?.mediaUserErrors ?? [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      return json({ ok: false, kind: "error", error: userErrors.map((e: { message: string }) => e.message).join("; "), code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }
    return json({ ok: true, kind: "apply_alt_text", imageId, applied: true });
  }

  // â”€â”€ Intent: apply_alt_text_bulk 
  if (intent === "apply_alt_text_bulk") {
    const plan = await getShopPlan(admin.graphql);
    if (!canUseFeature(plan, "altText")) {
      return json({ ok: false, kind: "error", error: "Upgrade required.", code: "PLAN_UPGRADE_REQUIRED", plan }, { status: 403 });
    }

    let items: { imageId: string; altText: string }[];
    try {
      items = JSON.parse(String(form.get("items") ?? "[]"));
    } catch {
      return json({ ok: false, kind: "error", error: "Invalid items", code: "INVALID_INPUT" }, { status: 400 });
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return json({ ok: false, kind: "error", error: "Invalid items list", code: "INVALID_INPUT" }, { status: 400 });
    }

    const media: { id: string; alt: string }[] = [];
    for (const item of items) {
      if (!item || typeof item.imageId !== "string" || !isValidMediaImageGid(item.imageId) || typeof item.altText !== "string" || !item.altText.trim()) {
        return json({ ok: false, kind: "error", error: "Invalid item in list", code: "INVALID_INPUT" }, { status: 400 });
      }
      media.push({ id: item.imageId, alt: stripHtml(item.altText.trim().slice(0, 512)) });
    }

    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      mutation UpdateImageAltBulk($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { id alt }
          mediaUserErrors { field message }
        }
      }`,
      { productId: productGid, media },
    );

    const userErrors = gql.data?.productUpdateMedia?.mediaUserErrors ?? [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      return json({ ok: false, kind: "error", error: userErrors.map((e: { message: string }) => e.message).join("; "), code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }
    return json({ ok: true, kind: "apply_alt_text_bulk", applied: true, count: media.length });
  }

  // â”€â”€ Intent: generate_meta 
  if (intent === "generate_meta") {
  const plan = await getShopPlan(admin.graphql);

  if (!canUseFeature(plan, "metaGeneration")) {
    return json(
      { ok: false, kind: "error", error: "Meta title & description generation requires a Basic plan or higher.", code: "PLAN_UPGRADE_REQUIRED", plan },
      { status: 403 },
    );
  }

  const jobId = String(form.get("jobId") ?? "");

  let creditRequestId: string | null = null;
  try {
    creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain, plan, amount: CREDIT_COSTS.metaGeneration,
      requestId: creditRequestId, kind: "generation",
      metadata: { intent: "generate_meta", productId: productGid },
    });

    if (!credit.allowed) {
      return json(
        { ok: false, kind: "error", code: "INSUFFICIENT_CREDITS", error: "Not enough credits", creditsRemaining: credit.creditsRemaining, plan },
        { status: 402 },
      );
    }

    const product = await fetchProductMeta(admin.graphql, productGid);
    if (!product) throw new Response("Product not found", { status: 404 });

    const keywords = normalizeKeywordList(String(form.get("keywords") ?? ""));
    const result = await generateMetaOnly({ title: product.title, vendor: product.vendor, productType: product.productType, tags: product.tags, keywords });

    // ── Persist onto the job so History can show it ──────────────────────
    if (jobId && isUuidV4(jobId)) {
      const job = await db.generationJob.findFirst({
        where: { id: jobId, shopDomain, productId: productGid },
        select: { result: true },
      });
      if (job) {
        const existing = (job.result && typeof job.result === "object") ? job.result as Record<string, unknown> : {};
        await db.generationJob.update({
          where: { id: jobId },
          data: {
            result: {
              ...existing,
              meta_title: result.meta_title ?? existing.meta_title,
              meta_description: result.meta_description ?? existing.meta_description,
            },
          },
        });
      }
    }

    return json({ ok: true, kind: "generate_meta", ...result });
  } catch (err) {
    if (creditRequestId) {
      await refundCredits({
        shopId: shopDomain, plan, amount: CREDIT_COSTS.metaGeneration,
        requestId: `${creditRequestId}:meta-failed`,
        metadata: { intent: "generate_meta", productId: productGid },
      });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ ok: false, kind: "error", error: message, code: "META_FAILED" }, { status: 500 });
  }
}

  // â”€â”€ Intent: apply_meta 
  if (intent === "apply_meta") {
    const plan = await getShopPlan(admin.graphql);
    if (!canUseFeature(plan, "metaGeneration")) {
      return json({ ok: false, kind: "error", error: "Upgrade required.", code: "PLAN_UPGRADE_REQUIRED", plan }, { status: 403 });
    }

    const metaTitle = String(form.get("metaTitle") ?? "").trim().slice(0, 70);
    const metaDescription = String(form.get("metaDescription") ?? "").trim().slice(0, 320);

    if (!metaTitle && !metaDescription) {
      return json({ ok: false, kind: "error", error: "Nothing to apply", code: "INVALID_INPUT" }, { status: 400 });
    }

    const gql = await adminGraphqlWithRetry<any>(
      admin.graphql,
      `#graphql
      mutation UpdateMeta($id: ID!, $seo: SEOInput) {
        productUpdate(input: { id: $id, seo: $seo }) {
          product { id }
          userErrors { field message }
        }
      }`,
      { id: productGid, seo: { ...(metaTitle && { title: metaTitle }), ...(metaDescription && { description: metaDescription }) } },
    );

    const userErrors = gql.data?.productUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return json({ ok: false, kind: "error", error: userErrors.map((e: { message: string }) => e.message).join("; "), code: "SHOPIFY_USER_ERRORS" }, { status: 422 });
    }
    return json({ ok: true, kind: "apply_meta", applied: true });
  }

  return json({ ok: false, kind: "error", error: "Invalid intent", code: "INVALID_INTENT" }, { status: 400 });
}