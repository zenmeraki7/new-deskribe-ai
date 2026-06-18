import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Select,
  TextField,
  Divider,
  Spinner,
  Box,
  Banner,
  Tag,
  ProgressBar,
} from "@shopify/polaris";

import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { suggestKeywords } from "../lib/ai.server";
import { db } from "../lib/db.server";
import { sanitiseHtml } from "../lib/html.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";
import { requireAdminSession } from "../lib/auth.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import { CreditUsageCard } from "../components/CreditUsageCard";
import { CREDIT_COSTS, formatCredits, hasCredits, usageProgress } from "../lib/credits";
import { appLog, durationSince } from "../utils/observability.server";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DUMMY_IMAGE =
  "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png";

const VIBE_OPTIONS = [
  { label: "Casual", value: "casual" },
  { label: "Luxury", value: "luxury" },
  { label: "Technical", value: "technical" },
  { label: "Playful", value: "playful" },
  { label: "Minimalist", value: "minimalist" },
];

const FORMAT_OPTIONS = [
  { label: "Paragraph", value: "paragraph" },
  { label: "Bullets", value: "bullets" },
  { label: "Hybrid", value: "hybrid" },
];

function formatResetDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  featuredImage: { url: string } | null;
}

interface LoaderData {
  product: ShopifyProduct | null;
  credits: {
    creditsUsed: number;
    creditsLimit: number;
    creditsRemaining: number;
    resetDate: string;
    plan: string;
  };
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — plain read, no transaction, no lock
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { admin, billing, shopDomain } = await requireAdminSession(request);
  let plan = resolvePlan(null);

  try {
    const { hasActivePayment, appSubscriptions } = await billing.check();
    plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

    if (!hasActivePayment) {
      throw redirect(
        `https://${shopDomain}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing`,
      );
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[billing.check error]", err);
  }

  const credits = await getCreditBalance(shopDomain, plan);

  try {
    const resp = await admin.graphql(`
      #graphql
      query GetFirstProduct {
        products(first: 1) {
          nodes {
            id
            title
            handle
            vendor
            productType
            tags
            featuredImage { url }
          }
        }
      }
    `);

    const data = await resp.json();
    const product: ShopifyProduct | null =
      data?.data?.products?.nodes?.[0] ?? null;

    return json<LoaderData>({
      product,
      credits: {
        creditsUsed: credits.creditsUsed,
        creditsLimit: credits.creditsLimit,
        creditsRemaining: credits.creditsRemaining,
        resetDate: credits.resetDate.toISOString(),
        plan: credits.plan,
      },
    });
  } catch (err) {
    return json<LoaderData>({
      product: null,
      credits: {
        creditsUsed: credits.creditsUsed,
        creditsLimit: credits.creditsLimit,
        creditsRemaining: credits.creditsRemaining,
        resetDate: credits.resetDate.toISOString(),
        plan: credits.plan,
      },
      error: "Failed to load product.",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const startedAt = Date.now();
  const nodeCrypto = await import("node:crypto");
  const { deductCredits, refundCredits } = await import(
    "../lib/creditService.server"
  );
  const { admin, billing, shopDomain } = await requireAdminSession(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── suggest_keywords ──────────────────────────────────────────────────────
  if (intent === "suggest_keywords") {
    const {
      consumeCreditWithIdempotency,
      getCreditStatus,
      InsufficientCreditsError,
    } =
      await import("../utils/credits.server");
    const creditRequestId = String(form.get("creditRequestId") || nodeCrypto.randomUUID());
    const title = String(form.get("title") ?? "");
    const vendor = String(form.get("vendor") ?? "");
    const productType = String(form.get("productType") ?? "");
    const tags = String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const { appSubscriptions } = await billing.check();
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
    const rate = await checkAndIncrementKeywordLimit(shopDomain, plan);

    if (!rate.allowed) {
      return json(
        {
          ok: false,
          kind: "error",
          code:
            rate.reason === "global_limit"
              ? "GLOBAL_LIMIT_REACHED"
              : "RATE_LIMIT_EXCEEDED",
          error:
            rate.reason === "global_limit"
              ? "Service is temporarily at capacity. Please try again in a few hours."
              : "Too many keyword requests. Please try again in a minute.",
        },
        { status: 429 },
      );
    }

    try {
      await consumeCreditWithIdempotency(
        shopDomain,
        "keyword_suggestion",
        CREDIT_COSTS.keywordSuggestion,
        creditRequestId,
      );
    } catch (err) {
      if (!(err instanceof InsufficientCreditsError)) throw err;
      appLog.warn("Dashboard keyword suggestion blocked by credit limit", {
        operation: "dashboard.suggest_keywords",
        shop: shopDomain,
        requestId: creditRequestId,
        durationMs: durationSince(startedAt),
        status: "insufficient_credits",
        error: err,
      });
      const status = await getCreditStatus(shopDomain);
      return json(
        {
          ok: false,
          kind: "error",
          code: "INSUFFICIENT_CREDITS",
          error: "credit_limit_reached",
          message: err.message,
          creditsRemaining: status.remaining,
          creditsLimit: status.creditLimit,
          resetDate: status.cycleEndsAt.toISOString(),
        },
        { status: 402 },
      );
    }

    try {
      const keywords = await suggestKeywords(title, vendor, productType, tags);
      appLog.info("Dashboard keyword suggestion completed", {
        operation: "dashboard.suggest_keywords",
        shop: shopDomain,
        requestId: creditRequestId,
        durationMs: durationSince(startedAt),
        status: "completed",
        keywordCount: keywords.length,
      });
      return json({ ok: true, kind: "suggest_keywords", keywords });
    } catch (err) {
      appLog.error("Dashboard keyword suggestion failed", {
        operation: "dashboard.suggest_keywords",
        shop: shopDomain,
        requestId: creditRequestId,
        durationMs: durationSince(startedAt),
        status: "failed",
        error: err,
      });
      return json(
        {
          ok: false,
          kind: "error",
          error:
            err instanceof Error ? err.message : "Keyword generation failed",
        },
        { status: 500 },
      );
    }
  }

  // ── generate ──────────────────────────────────────────────────────────────
  if (intent === "generate") {
    let creditRequestId: string | null = null;
    let plan = resolvePlan(null);
    let productId = "";

    try {
      const { appSubscriptions } = await billing.check();
      plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
      const rate = await checkAndIncrementRateLimit(shopDomain, plan);

      if (!rate.allowed) {
        return json(
          {
            ok: false,
            kind: "error",
            code:
              rate.reason === "global_limit"
                ? "GLOBAL_LIMIT_REACHED"
                : "RATE_LIMIT_EXCEEDED",
            error:
              rate.reason === "global_limit"
                ? "Service is temporarily at capacity. Please try again in a few hours."
                : "Too many generation requests. Please try again in a minute.",
          },
          { status: 429 },
        );
      }

      productId = String(form.get("productId") ?? "");
      const vibe = String(form.get("vibe") ?? "casual");
      const format = String(form.get("format") ?? "paragraph");
      const keywords = String(form.get("keywords") ?? "");
      const includeSocials = form.get("includeSocials") === "true";

      creditRequestId = String(form.get("creditRequestId") || nodeCrypto.randomUUID());
      const credit = await deductCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: creditRequestId,
        kind: "generation",
        metadata: { intent: "index_generate", productId },
      });

      if (!credit.allowed) {
        appLog.warn("Dashboard generation blocked by credit limit", {
          operation: "dashboard.generate",
          shop: shopDomain,
          requestId: creditRequestId,
          productId,
          durationMs: durationSince(startedAt),
          status: "insufficient_credits",
        });
        return json(
          {
            ok: false,
            kind: "error",
            code: "INSUFFICIENT_CREDITS",
            error: "credit_limit_reached",
            message: "Your monthly credit limit has been reached.",
            creditsRemaining: credit.creditsRemaining,
            creditsLimit: credit.creditsLimit,
            resetDate: credit.resetDate.toISOString(),
          },
          { status: 402 },
        );
      }

      const { jobIds, skipped } = await enqueueGenerationJobs({
        shopDomain,
        productIds: [productId],
        vibe,
        format,
        keywords,
        includeSocials,
        creditRequestId,
        creditCost: CREDIT_COSTS.standardGeneration,
        adminGraphql: (query, opts) => admin.graphql(query, opts),
      });

      if (skipped.includes(productId) || jobIds.length === 0) {
        await refundCredits({
          shopId: shopDomain,
          plan,
          amount: CREDIT_COSTS.standardGeneration,
          requestId: `${creditRequestId}:enqueue-empty`,
          metadata: { intent: "index_generate", productId },
        });
        return json(
          {
            ok: false,
            kind: "error",
            error: "Product not found or access denied",
            code: "NOT_FOUND_OR_DENIED",
          },
          { status: 403 },
        );
      }

      appLog.info("Dashboard generation queued", {
        operation: "dashboard.generate",
        shop: shopDomain,
        jobId: jobIds[0],
        requestId: creditRequestId,
        productId,
        durationMs: durationSince(startedAt),
        status: "queued",
      });

      return json({
        ok: true,
        kind: "generate",
        jobId: jobIds[0],
        status: "PENDING",
      });

    } catch (err) {
      if (creditRequestId) {
        await refundCredits({
          shopId: shopDomain,
          plan,
          amount: CREDIT_COSTS.standardGeneration,
          requestId: `${creditRequestId}:failed`,
          metadata: { intent: "index_generate" },
        });
      }
      appLog.error("Dashboard generation failed", {
        operation: "dashboard.generate",
        shop: shopDomain,
        requestId: creditRequestId,
        productId,
        durationMs: durationSince(startedAt),
        status: "failed",
        error: err,
      });
      return json(
        {
          ok: false,
          kind: "error",
          error:
            err instanceof Error
              ? err.message
              : "Description generation failed",
        },
        { status: 500 },
      );
    }
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  if (intent === "apply") {
    const jobId = String(form.get("jobId") ?? "");

    if (!jobId) {
      return json(
        { ok: false, error: "Missing draft ID" },
        { status: 400 },
      );
    }

    try {
      const job = await db.generationJob.findFirst({
        where: { id: jobId, shopDomain, status: "COMPLETED" },
        select: { id: true, productId: true, result: true },
      });
      const stored = job?.result as { body_html?: unknown } | null | undefined;
      const bodyHtml =
        typeof stored?.body_html === "string" ? sanitiseHtml(stored.body_html) : "";

      if (!job || !bodyHtml) {
        return json(
          { ok: false, error: "Draft not found or invalid" },
          { status: 404 },
        );
      }

      const currentResponse = await admin.graphql(
        `#graphql
        query ProductDescription($id: ID!) {
          product(id: $id) { descriptionHtml }
        }`,
        { variables: { id: job.productId } },
      );
      const currentBody = await currentResponse.json();
      const previousDescription = sanitiseHtml(
        String(currentBody?.data?.product?.descriptionHtml ?? ""),
      );

      const response = await admin.graphql(
        `#graphql
        mutation UpdateProduct($id: ID!, $descriptionHtml: String!) {
          productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml }) {
            product { id }
            userErrors { field message }
          }
        }`,
        { variables: { id: job.productId, descriptionHtml: bodyHtml } },
      );

      const result = await response.json();
      const userErrors = result?.data?.productUpdate?.userErrors;

      if (userErrors && userErrors.length > 0) {
        appLog.warn("Dashboard apply rejected by Shopify", {
          operation: "dashboard.apply",
          shop: shopDomain,
          jobId,
          productId: job.productId,
          durationMs: durationSince(startedAt),
          status: "shopify_user_errors",
          error: userErrors[0].message,
        });
        return json(
          { ok: false, error: userErrors[0].message },
          { status: 400 },
        );
      }

      await db.generationJob.update({
        where: { id: job.id },
        data: {
          generatedDescription: bodyHtml,
          previousDescription,
        },
      });

      appLog.info("Dashboard apply completed", {
        operation: "dashboard.apply",
        shop: shopDomain,
        jobId,
        productId: job.productId,
        durationMs: durationSince(startedAt),
        status: "applied",
      });

      return json({ ok: true, applied: true });
    } catch (err) {
      appLog.error("Dashboard apply failed", {
        operation: "dashboard.apply",
        shop: shopDomain,
        jobId,
        durationMs: durationSince(startedAt),
        status: "failed",
        error: err,
      });
      return json(
        {
          ok: false,
          error:
            err instanceof Error ? err.message : "Failed to apply description",
        },
        { status: 500 },
      );
    }
  }

  return json(
    { ok: false, kind: "error", error: "Invalid intent" },
    { status: 400 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function IndexPage() {
  const { product, error, credits } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const suggestFetcher = useFetcher<any>();
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();

  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [localCreditError, setLocalCreditError] = useState<string | null>(null);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const isGenerating = generateFetcher.state !== "idle";
  const isSuggestingKeywords = suggestFetcher.state !== "idle";

  const generationResult =
    generateFetcher.data?.kind === "generate" && generateFetcher.data?.ok
      ? generateFetcher.data.result
      : null;
  const generationQueued =
    generateFetcher.data?.kind === "generate" &&
    generateFetcher.data?.ok &&
    generateFetcher.data.status === "PENDING";

  const isCreditLimitError =
    localCreditError === "Not enough credits" ||
    (generateFetcher.data?.ok === false &&
      generateFetcher.data.code === "INSUFFICIENT_CREDITS") ||
    (suggestFetcher.data?.ok === false &&
      suggestFetcher.data.code === "INSUFFICIENT_CREDITS");

  const creditLimitMessage =
    credits.creditsUsed > credits.creditsLimit
      ? `You're over your ${credits.plan} plan limit (${formatCredits(
          credits.creditsUsed,
        )}/${formatCredits(credits.creditsLimit)} used). Upgrade or wait until ${formatResetDate(
          credits.resetDate,
        )} for reset.`
      : `You've used all credits on your ${credits.plan} plan. Upgrade or wait until ${formatResetDate(
          credits.resetDate,
        )} for reset.`;

  const actionError =
    (isCreditLimitError ? creditLimitMessage : null) ??
    (generateFetcher.data?.ok === false ? generateFetcher.data.error : null) ??
    (suggestFetcher.data?.ok === false ? suggestFetcher.data.error : null);

  const creditCosts = useMemo(
    () => ({
      generation: CREDIT_COSTS.standardGeneration,
      keywordSuggestion: CREDIT_COSTS.keywordSuggestion,
    }),
    [],
  );

  const remainingCredits = useMemo(() => {
    const spent =
      (generateFetcher.data?.ok === true &&
      generateFetcher.data?.kind === "generate"
        ? creditCosts.generation
        : 0) +
      (suggestFetcher.data?.ok === true &&
      suggestFetcher.data?.kind === "suggest_keywords"
        ? creditCosts.keywordSuggestion
        : 0);
    return Math.max(0, credits.creditsRemaining - spent);
  }, [credits.creditsRemaining, creditCosts, generateFetcher.data, suggestFetcher.data]);

  const isApplying = applyFetcher.state !== "idle";
  const canApply =
    generationResult && generationResult.body_html && !isGenerating && !isApplying;
  const creditProgress = usageProgress(
    credits.creditsLimit - remainingCredits,
    credits.creditsLimit,
  );

  const handleGenerate = useCallback(() => {
    if (!product) return;
    if (!hasCredits(remainingCredits, creditCosts.generation)) {
      setLocalCreditError("Not enough credits");
      return;
    }
    setLocalCreditError(null);
    const fd = new FormData();
    fd.append("intent", "generate");
    fd.append("productId", product.id);
    fd.append("vibe", vibe);
    fd.append("format", format);
    fd.append("keywords", keywords);
    fd.append("includeSocials", String(includeSocials));
    fd.append("creditRequestId", globalThis.crypto.randomUUID());
    generateFetcher.submit(fd, { method: "POST" });
  }, [product, remainingCredits, creditCosts.generation, vibe, format, keywords, includeSocials, generateFetcher]);

  const handleSuggestKeywords = useCallback(() => {
    if (!product) return;
    if (!hasCredits(remainingCredits, creditCosts.keywordSuggestion)) {
      setLocalCreditError("Not enough credits");
      return;
    }
    setLocalCreditError(null);
    const fd = new FormData();
    fd.append("intent", "suggest_keywords");
    fd.append("title", product.title);
    fd.append("vendor", product.vendor);
    fd.append("productType", product.productType);
    fd.append("tags", product.tags.join(","));
    fd.append("creditRequestId", globalThis.crypto.randomUUID());
    suggestFetcher.submit(fd, { method: "POST" });
  }, [product, remainingCredits, creditCosts.keywordSuggestion, suggestFetcher]);

  const handleKeywordTagRemove = useCallback((kw: string) => {
    setKeywords((prev) =>
      prev
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k && k !== kw)
        .join(", "),
    );
  }, []);

  useEffect(() => {
    if (applyFetcher.data?.ok && applyFetcher.data?.applied) {
      setShowSuccessBanner(true);
      const timer = setTimeout(() => setShowSuccessBanner(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [applyFetcher.data]);

  const suggestedKeywords: string[] =
    suggestFetcher.data?.kind === "suggest_keywords" && suggestFetcher.data?.ok
      ? suggestFetcher.data.keywords
      : [];

  const handleAddSuggestedKeyword = useCallback((kw: string) => {
    setKeywords((prev) => {
      const existing = prev.split(",").map((k) => k.trim()).filter(Boolean);
      if (existing.includes(kw)) return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  const handleClear = useCallback(() => {
    setVibe("casual");
    setFormat("paragraph");
    setKeywords("");
    setIncludeSocials(false);
    generateFetcher.load(window.location.pathname);
  }, [generateFetcher]);

  const imageUrl = product?.featuredImage?.url ?? DUMMY_IMAGE;
  const keywordTags = keywords.split(",").map((k) => k.trim()).filter(Boolean);

  if (error) {
    return (
      <Page title="DescribeAI" subtitle="AI Product Description Generator">
        <Layout>
          <Layout.Section>
            <Banner tone="critical" title="Error loading product">
              <Text as="p">{error}</Text>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  if (!product) {
    return (
      <Page title="DescribeAI" subtitle="AI Product Description Generator">
        <Layout>
          <Layout.Section>
            <Card>
              <InlineStack align="center">
                <Spinner size="large" />
              </InlineStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="DescribeAI" subtitle="AI Product Description Generator">
      <Layout>
        <Layout.Section>

          {/* ── Stats Bar ─────────────────────────────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1px",
              background: "#e1e3e5",
              border: "1px solid #e1e3e5",
              borderRadius: "12px",
              overflow: "hidden",
              marginBottom: "16px",
            }}
          >
            {[
              {
                label: "Generated",
                value: `${generationResult?.wordCount ?? 373} words`,
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="2" y="4" width="16" height="2" rx="1" fill="#5c6ac4"/>
                    <rect x="2" y="9" width="12" height="2" rx="1" fill="#5c6ac4"/>
                    <rect x="2" y="14" width="14" height="2" rx="1" fill="#5c6ac4"/>
                  </svg>
                ),
              },
              {
                label: "Credits left",
                value: String(remainingCredits),
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="10" r="7" stroke="#f59e0b" strokeWidth="2"/>
                    <text x="10" y="14" textAnchor="middle" fontSize="9" fill="#f59e0b" fontWeight="bold">$</text>
                  </svg>
                ),
              },
              {
                label: "Current Plan",
                value: credits.creditsLimit > 100 ? "PRO" : "FREE",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="3" y="5" width="14" height="10" rx="2" stroke="#5c6ac4" strokeWidth="2"/>
                    <path d="M3 9h14" stroke="#5c6ac4" strokeWidth="1.5"/>
                    <rect x="6" y="12" width="4" height="1.5" rx="0.75" fill="#5c6ac4"/>
                  </svg>
                ),
              },
            ].map(({ label, value, icon }) => (
              <div
                key={label}
                style={{
                  background: "#ffffff",
                  padding: "20px 24px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "4px" }}>{label}</div>
                  <div style={{ fontSize: "18px", fontWeight: "600", color: "#202223" }}>{value}</div>
                </div>
                <div style={{ opacity: 0.85 }}>{icon}</div>
              </div>
            ))}
          </div>

          {/* ── Quick Generate Panel ───────────────────────────────────────── */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e1e3e5",
              borderRadius: "12px",
              padding: "24px",
              marginBottom: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "24px",
            }}
          >
            {/* Top row: steps + preview */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "32px",
                alignItems: "center",
              }}
            >
              {/* Left: steps + controls */}
              <div>
                <Text as="h2" variant="headingMd" fontWeight="semibold">
                  What do you want to generate?
                </Text>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "12px",
                    marginTop: "20px",
                    marginBottom: "24px",
                  }}
                >
                  {[
                    {
                      step: "1. Select Content Type",
                      icon: (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                          <rect x="3" y="5" width="18" height="3" rx="1.5" fill="#5c6ac4"/>
                          <rect x="3" y="11" width="14" height="3" rx="1.5" fill="#8c9196"/>
                          <rect x="3" y="17" width="10" height="3" rx="1.5" fill="#8c9196"/>
                        </svg>
                      ),
                    },
                    {
                      step: "2. Select Target",
                      icon: (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="8" stroke="#5c6ac4" strokeWidth="2"/>
                          <circle cx="12" cy="12" r="4" stroke="#5c6ac4" strokeWidth="1.5"/>
                          <circle cx="12" cy="12" r="1.5" fill="#5c6ac4"/>
                        </svg>
                      ),
                    },
                    {
                      step: "3. Click Generate",
                      icon: (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                          <path d="M12 3l2.5 6h6l-5 4 2 6.5L12 16l-5.5 3.5 2-6.5-5-4h6z" stroke="#5c6ac4" strokeWidth="1.5" fill="none"/>
                        </svg>
                      ),
                    },
                  ].map(({ step, icon }) => (
                    <div
                      key={step}
                      style={{
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        padding: "16px 12px",
                        textAlign: "center",
                        background: "#fafbfb",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "center", marginBottom: "8px" }}>{icon}</div>
                      <div style={{ fontSize: "13px", color: "#202223", fontWeight: "500" }}>{step}</div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => navigate("/app/products")}
                  style={{
                    background: "linear-gradient(135deg, #5c6ac4 0%, #4355be 100%)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "10px",
                    padding: "12px 28px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    boxShadow: "0 2px 8px rgba(92,106,196,0.35)",
                    letterSpacing: "0.01em",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2l2 4h4l-3.5 3 1.5 4.5L8 11l-4 2.5 1.5-4.5L2 6h4z" fill="#fff"/>
                  </svg>
                  Start Generating
                </button>
              </div>

              {/* Right: preview thumbnail placeholder */}
              <div
                style={{
                  background: "#f6f6f7",
                  borderRadius: "10px",
                  overflow: "hidden",
                  aspectRatio: "16/9",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "linear-gradient(135deg, #e8eaff 0%, #f0f4ff 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {/* Simulated UI preview */}
                  <div style={{ width: "80%", background: "#fff", borderRadius: "6px", padding: "10px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
                    <div style={{ height: "8px", background: "#e1e3e5", borderRadius: "4px", marginBottom: "6px", width: "60%" }} />
                    <div style={{ height: "6px", background: "#e1e3e5", borderRadius: "4px", marginBottom: "4px", width: "90%" }} />
                    <div style={{ height: "6px", background: "#e1e3e5", borderRadius: "4px", width: "75%" }} />
                  </div>
                  <div
                    style={{
                      width: "44px",
                      height: "44px",
                      background: "rgba(0,0,0,0.35)",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      position: "absolute",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l6 4-6 4V4z" fill="#fff"/>
                    </svg>
                  </div>
                  {/* Sparkle accent */}
                  <div style={{ position: "absolute", bottom: "16px", right: "20px", fontSize: "20px" }}>✨</div>
                </div>
              </div>
            </div>

            {/* ── How It Works — inside the panel ──────────────────────────── */}
            <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: "24px" }}>
              <Text as="h2" variant="headingMd" fontWeight="semibold">
                🚀 How It Works
              </Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: "16px",
                  marginTop: "16px",
                }}
              >
                {[
                  {
                    num: "1",
                    title: "Select a Product",
                    desc: "Choose a product from the table to get started.",
                    icon: (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <rect x="2" y="3" width="16" height="14" rx="2" stroke="#5c6ac4" strokeWidth="1.5"/>
                        <rect x="5" y="7" width="10" height="1.5" rx="0.75" fill="#5c6ac4"/>
                        <rect x="5" y="10" width="7" height="1.5" rx="0.75" fill="#8c9196"/>
                        <rect x="5" y="13" width="8" height="1.5" rx="0.75" fill="#8c9196"/>
                      </svg>
                    ),
                  },
                  {
                    num: "2",
                    title: "Customize Settings",
                    desc: "Adjust tone, length, and other generation options to match your needs.",
                    icon: (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <circle cx="10" cy="10" r="3" stroke="#5c6ac4" strokeWidth="1.5"/>
                        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" stroke="#5c6ac4" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    ),
                  },
                  {
                    num: "3",
                    title: "Generate Draft",
                    desc: "Click the generate button to create your AI-powered product description.",
                    icon: (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path d="M10 2l2 5h5l-4 3 1.5 5L10 12l-4.5 3L7 10 3 7h5z" stroke="#5c6ac4" strokeWidth="1.5" fill="none"/>
                      </svg>
                    ),
                  },
                  {
                    num: "4",
                    title: "Save to Shopify",
                    desc: "Review the draft and save it directly to your Shopify store with one click.",
                    icon: (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path d="M14 8.5C14 5.46 11.54 3 8.5 3S3 5.46 3 8.5 5.46 14 8.5 14" stroke="#5c6ac4" strokeWidth="1.5" strokeLinecap="round"/>
                        <path d="M11 13l6 6" stroke="#5c6ac4" strokeWidth="1.5" strokeLinecap="round"/>
                        <path d="M8.5 6v5M6 8.5h5" stroke="#5c6ac4" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    ),
                  },
                ].map(({ num, title, desc, icon }) => (
                  <div
                    key={num}
                    style={{
                      background: "#fafbfb",
                      border: "1px solid #e1e3e5",
                      borderRadius: "8px",
                      padding: "16px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "8px",
                      }}
                    >
                      <div
                        style={{
                          width: "24px",
                          height: "24px",
                          background: "linear-gradient(135deg, #5c6ac4 0%, #4355be 100%)",
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "12px",
                          fontWeight: "700",
                          color: "#fff",
                          flexShrink: 0,
                        }}
                      >
                        {num}
                      </div>
                      <div style={{ opacity: 0.85 }}>{icon}</div>
                    </div>
                    <div style={{ fontSize: "13px", fontWeight: "600", color: "#202223", marginBottom: "4px" }}>
                      {title}
                    </div>
                    <div style={{ fontSize: "13px", color: "#6d7175", lineHeight: "1.5" }}>
                      {desc}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Existing banners ──────────────────────────────────────────── */}
          {showSuccessBanner && (
            <Banner
              tone="success"
              title="Applied to Shopify"
              onDismiss={() => setShowSuccessBanner(false)}
            >
              <Text as="p">
                The product description has been successfully updated in Shopify.
              </Text>
            </Banner>
          )}

          {generationQueued && (
            <Banner
              tone="info"
              title="Draft generation queued"
              action={{
                content: "View jobs",
                url: "/app/jobs",
                target: "_self",
              }}
            >
              <Text as="p">
                The draft is being generated in the background. You can continue working.
              </Text>
            </Banner>
          )}

          {actionError && (
            <Banner
              tone="critical"
              title={isCreditLimitError ? "Credit limit reached" : "Something went wrong"}
              action={
                isCreditLimitError
                  ? { content: "Upgrade plan", url: "/app/billing", target: "_self" }
                  : undefined
              }
              secondaryAction={
                isCreditLimitError
                  ? { content: "View usage", url: "/app/credits", target: "_self" }
                  : undefined
              }
            >
              <Text as="p">{actionError}</Text>
            </Banner>
          )}

          {applyFetcher.data?.ok === false && applyFetcher.data?.error && (
            <Banner tone="critical" title="Failed to apply description">
              <Text as="p">{applyFetcher.data.error}</Text>
            </Banner>
          )}

          <CreditUsageCard
            compact
            title="Credits remaining"
            creditsUsed={credits.creditsLimit - remainingCredits}
            creditsLimit={credits.creditsLimit}
            creditsRemaining={remainingCredits}
            planName={credits.plan}
            resetDate={credits.resetDate}
          />

          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Credits used
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {formatCredits(credits.creditsLimit - remainingCredits)} /{" "}
                  {formatCredits(credits.creditsLimit)} credits used (
                  {credits.plan} plan)
                </Text>
              </InlineStack>
              <ProgressBar
                progress={creditProgress}
                tone={creditProgress > 90 ? "critical" : "highlight"}
                size="small"
              />
            </BlockStack>
          </Card>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 2fr",
              gap: "16px",
              alignItems: "start",
            }}
          >
            {/* ── LEFT: Product Card ─────────────────────────────────────── */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Selected Product
                </Text>

                <Box background="bg-surface-secondary" borderRadius="200">
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "1 / 1",
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={imageUrl}
                      alt={product.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                </Box>

                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">
                    {product.title}
                  </Text>
                  {product.vendor && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Vendor: {product.vendor}
                    </Text>
                  )}
                  {product.productType && (
                    <Badge>{product.productType}</Badge>
                  )}
                  {!product.featuredImage && (
                    <Badge tone="warning">Using placeholder image</Badge>
                  )}
                </BlockStack>

                <Button fullWidth onClick={() => navigate("/app/products")}>
                  Change Product
                </Button>
              </BlockStack>
            </Card>

            {/* ── RIGHT: Settings + Output ───────────────────────────────── */}
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">
                    Generation Settings
                  </Text>

                  <InlineStack gap="300" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Writing style (tone)"
                        options={VIBE_OPTIONS}
                        value={vibe}
                        onChange={setVibe}
                        disabled={isGenerating}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Format"
                        options={FORMAT_OPTIONS}
                        value={format}
                        onChange={setFormat}
                        disabled={isGenerating}
                      />
                    </div>
                  </InlineStack>

                  <BlockStack gap="200">
                    <InlineStack gap="200" align="space-between" blockAlign="end">
                      <TextField
                        label="Keywords (comma-separated)"
                        value={keywords}
                        onChange={setKeywords}
                        placeholder="e.g. eco-friendly, handmade, organic cotton"
                        autoComplete="off"
                        disabled={isGenerating}
                        connectedRight={
                          <Button
                            onClick={handleSuggestKeywords}
                            loading={isSuggestingKeywords}
                            disabled={
                              isGenerating ||
                              isSuggestingKeywords ||
                              !hasCredits(
                                remainingCredits,
                                creditCosts.keywordSuggestion,
                              )
                            }
                          >
                            Suggest
                          </Button>
                        }
                      />
                    </InlineStack>

                    {keywordTags.length > 0 && (
                      <InlineStack gap="100" wrap>
                        {keywordTags.map((kw) => (
                          <Tag key={kw} onRemove={() => handleKeywordTagRemove(kw)}>
                            {kw}
                          </Tag>
                        ))}
                      </InlineStack>
                    )}

                    {suggestedKeywords.length > 0 && (
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Suggested — click to add:
                        </Text>
                        <InlineStack gap="100" wrap>
                          {suggestedKeywords.map((kw) => (
                            <button
                              key={kw}
                              onClick={() => handleAddSuggestedKeyword(kw)}
                              style={{
                                background: "none",
                                border: "1px solid #c9cccf",
                                borderRadius: "4px",
                                padding: "2px 8px",
                                cursor: "pointer",
                                fontSize: "13px",
                                color: "#202223",
                              }}
                            >
                              + {kw}
                            </button>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    )}
                  </BlockStack>

                  <Button
                    variant="primary"
                    tone="success"
                    onClick={handleGenerate}
                    loading={isGenerating}
                    disabled={
                      isGenerating ||
                      isSuggestingKeywords ||
                      !hasCredits(remainingCredits, creditCosts.generation)
                    }
                  >
                    Generate Description
                  </Button>

                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Credit cost before generation
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(creditCosts.generation)} credit
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Remaining credits before action
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(remainingCredits)}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="p" variant="headingSm">
                    Generated Output
                  </Text>
                  <Divider />

                  {isGenerating ? (
                    <InlineStack align="center">
                      <Spinner size="large" />
                    </InlineStack>
                  ) : generationResult ? (
                    <BlockStack gap="400">
                      {generationResult.headline && (
                        <Text variant="headingMd" as="h3">
                          {generationResult.headline}
                        </Text>
                      )}

                      <div
                        dangerouslySetInnerHTML={{
                          __html: generationResult.body_html,
                        }}
                        style={{ lineHeight: "1.6" }}
                      />

                      {generationResult.social_caption && (
                        <>
                          <Divider />
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">
                              Instagram Caption
                            </Text>
                            <Text as="p" tone="subdued">
                              {generationResult.social_caption}
                            </Text>
                          </BlockStack>
                        </>
                      )}

                      <Divider />

                      <InlineStack gap="600">
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">
                            {generationResult.wordCount}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Words
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">
                            {generationResult.charCount}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Characters
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">{vibe}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Style
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">{format}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Format
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Button
                            variant="primary"
                            tone="success"
                            disabled={!canApply}
                            loading={isApplying}
                            onClick={() => {
                              if (!product || !generationResult) return;
                              const fd = new FormData();
                              fd.append("intent", "apply");
                              fd.append("jobId", generationResult.jobId);
                              applyFetcher.submit(fd, { method: "POST" });
                            }}
                          >
                            Apply to Shopify
                          </Button>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Button
                            variant="tertiary"
                            tone="critical"
                            onClick={handleClear}
                          >
                            Clear
                          </Button>
                        </BlockStack>
                      </InlineStack>

                      {generationResult.primary_keyword && (
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="p" variant="bodySm" tone="subdued">
                            Primary keyword:
                          </Text>
                          <Badge>{generationResult.primary_keyword}</Badge>
                        </InlineStack>
                      )}
                    </BlockStack>
                  ) : (
                    <Text as="p" tone="subdued">
                      Configure settings above and click "Generate Description"
                      to create an AI-powered product description.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
