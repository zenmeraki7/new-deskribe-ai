// app/routes/app._index.tsx
//
// Priority 1 fix: generate action no longer calls generateProductDescription() inline.
// It creates a GenerationJob + enqueues to BullMQ and returns {ok, jobId} immediately.
// The UI then polls /app/api/job/:jobId (same endpoint used by app.products.$productId)
// until COMPLETED / FAILED / CANCELLED, then displays the result.
//
// suggest_keywords  — stays synchronous (fast, correct as-is)
// apply             — stays synchronous (Shopify write, no AI)

import crypto from "node:crypto";
import { useState, useCallback, useEffect, useRef } from "react";
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
} from "@shopify/polaris";

import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { suggestKeywords } from "../lib/ai.server";
import { requireAdminSession } from "../lib/auth.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import { CREDIT_COSTS } from "../lib/credits";
import { CreditUsageCard } from "../components/CreditUsageCard";
import { formatCredits, hasCredits } from "../lib/credits";
import { db } from "../lib/db.server";
import { generationQueue } from "../lib/queue.server";

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

// Poll every 2.5 s ± 20 % jitter — same rhythm as app.products.$productId
const POLL_INTERVAL_MS = 2500;
const POLL_JITTER_RATIO = 0.2;
// Abandon polling after 5 minutes
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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
  images: { url: string; altText: string | null }[];
}

interface LoaderData {
  product: ShopifyProduct | null;
  credits: {
    creditsUsed: number;
    creditsLimit: number;
    creditsRemaining: number;
    resetDate: string;
  };
  error?: string;
}

type PollStatus =
  | "IDLE"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface DraftResult {
  body_html: string;
  meta_title: string;
  meta_description: string;
  keywords: string[];
  social_caption?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — plain read, no transaction, no lock
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { admin, billing, shopDomain } = await requireAdminSession(request);
  let plan = resolvePlan(null);

  try {
    const { appSubscriptions } = await billing.check();
    plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
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
            featuredImage { url altText }
            images(first: 10) {
              nodes { url altText }
            }
          }
        }
      }
    `);

    const data = await resp.json();
    const rawProduct = data?.data?.products?.nodes?.[0] ?? null;

    const product: ShopifyProduct | null = rawProduct
      ? { ...rawProduct, images: rawProduct.images?.nodes ?? [] }
      : null;

    return json<LoaderData>({
      product,
      credits: {
        creditsUsed: credits.creditsUsed,
        creditsLimit: credits.creditsLimit,
        creditsRemaining: credits.creditsRemaining,
        resetDate: credits.resetDate.toISOString(),
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
      },
      error: "Failed to load product.",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { deductCredits, refundCredits } =
    await import("../lib/creditService.server");
  const { admin, billing, shopDomain } = await requireAdminSession(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── suggest_keywords — unchanged, stays synchronous ───────────────────────
  if (intent === "suggest_keywords") {
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

    const creditRequestId = crypto.randomUUID();
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.keywordSuggestion,
      requestId: creditRequestId,
      kind: "keyword_suggestion",
      metadata: { intent: "index_suggest_keywords" },
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
        },
        { status: 402 },
      );
    }

    try {
      const keywords = await suggestKeywords(title, vendor, productType, tags);
      return json({ ok: true, kind: "suggest_keywords", keywords });
    } catch (err) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.keywordSuggestion,
        requestId: `${creditRequestId}:failed`,
        metadata: { intent: "index_suggest_keywords" },
      });
      console.error("Keyword generation error:", err);
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

  // ── generate — FIXED: authenticate → validate → enqueue → return jobId ────
  //
  // Previously: called generateProductDescription() here, blocking for 5-15 s.
  // Now:        creates a GenerationJob record, enqueues it to BullMQ, and
  //             returns { ok: true, jobId } in < 500 ms.
  //             The UI polls /app/api/job/:jobId until terminal status.
  //
  if (intent === "generate") {
    let creditRequestId: string | null = null;
    let plan = resolvePlan(null);

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

      // ── 1. Read + validate form fields ──────────────────────────────────
      const productId = String(form.get("productId") ?? "");
      const productTitle = String(form.get("productTitle") ?? "");
      const vibe = String(form.get("vibe") ?? "casual");
      const format = String(form.get("format") ?? "paragraph");
      const keywords = String(form.get("keywords") ?? "");
      const includeSocials = form.get("includeSocials") === "true";

      if (!productId) {
        return json(
          { ok: false, kind: "error", error: "Missing product ID." },
          { status: 400 },
        );
      }

      // ── 2. Deduct credits before enqueueing ──────────────────────────────
      creditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: creditRequestId,
        kind: "generation",
        metadata: { intent: "index_generate", productId },
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
          },
          { status: 402 },
        );
      }

      // ── 3. Create the GenerationJob DB record ────────────────────────────
      const traceId = crypto.randomUUID();
      const inputHash = crypto
        .createHash("sha256")
        .update(`${shopDomain}:${productId}:${vibe}:${format}:${keywords}`)
        .digest("hex");

      const job = await db.generationJob.create({
        data: {
          shopDomain,
          productId,
          productTitle: productTitle || "Unknown product",
          vibe,
          format,
          keywords,
          includeSocials,
          status: "PENDING",
          progress: 0,
          traceId,
          inputHash,
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
        },
      });

      // ── 4. Derive bullJobId and update record ────────────────────────────
      const bullJobId = `${shopDomain}_${job.id}`;
      await db.generationJob.update({
        where: { id: job.id },
        data: { bullJobId },
      });

      // ── 5. Enqueue to BullMQ — if this fails, refund and surface error ───
      try {
        await generationQueue.add(
          `generate:${productId}`,
          {
            traceId,
            jobId: job.id,
            bulkId: crypto.randomUUID(),
            shopDomain,
            productId,
            productTitle: productTitle || "Unknown product",
            vibe,
            format,
            keywords,
            includeSocials,
            creditRequestId,
            creditCost: CREDIT_COSTS.standardGeneration,
            isStale: false,
          },
          {
            jobId: bullJobId,
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      } catch (enqueueErr: any) {
        // BullMQ "already exists" is safe to swallow — job is already queued
        const msg =
          typeof enqueueErr?.message === "string" ? enqueueErr.message : "";
        if (!(msg.includes("Job") && msg.includes("already exists"))) {
          // Real enqueue failure — refund credits and mark job failed
          await refundCredits({
            shopId: shopDomain,
            plan,
            amount: CREDIT_COSTS.standardGeneration,
            requestId: `${creditRequestId}:enqueue-failed`,
            metadata: { intent: "index_generate", productId },
          });
          await db.generationJob.update({
            where: { id: job.id },
            data: {
              status: "FAILED",
              errorMessage: "Enqueue failed. Please try again.",
            },
          });
          console.error("[index generate] BullMQ enqueue failed:", enqueueErr);
          return json(
            { ok: false, kind: "error", error: "Failed to queue generation. Please try again." },
            { status: 503 },
          );
        }
      }

      // ── 6. Return jobId immediately — UI will poll ────────────────────────
      return json({ ok: true, kind: "generate", jobId: job.id });
    } catch (err) {
      // Unexpected error — refund if we already deducted
      if (creditRequestId) {
        await refundCredits({
          shopId: shopDomain,
          plan,
          amount: CREDIT_COSTS.standardGeneration,
          requestId: `${creditRequestId}:failed`,
          metadata: { intent: "index_generate" },
        }).catch(() => {});
      }
      console.error("[index generate] Unexpected error:", err);
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

  // ── apply — unchanged, stays synchronous (just a Shopify write) ───────────
  if (intent === "apply") {
    const productId = String(form.get("productId") ?? "");
    const bodyHtml = String(form.get("bodyHtml") ?? "");

    if (!productId || !bodyHtml) {
      return json(
        { ok: false, error: "Missing product or description" },
        { status: 400 },
      );
    }

    try {
      const response = await admin.graphql(
        `#graphql
        mutation UpdateProduct($id: ID!, $descriptionHtml: String!) {
          productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml }) {
            product { id }
            userErrors { field message }
          }
        }`,
        { variables: { id: productId, descriptionHtml: bodyHtml } },
      );

      const result = await response.json();
      const userErrors = result?.data?.productUpdate?.userErrors;

      if (userErrors && userErrors.length > 0) {
        return json(
          { ok: false, error: userErrors[0].message },
          { status: 400 },
        );
      }

      return json({ ok: true, applied: true });
    } catch (err) {
      console.error("Apply error:", err);
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
// Polling hook — mirrors the one in app.products.$productId.ui.tsx
// ─────────────────────────────────────────────────────────────────────────────

interface PollPayload {
  status: PollStatus;
  result: DraftResult | null;
  errorMessage: string | null;
}

function useJobPoll() {
  const fetcher = useFetcher<PollPayload>();
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<PollStatus>("IDLE");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const TERMINAL = new Set<PollStatus>(["COMPLETED", "FAILED", "CANCELLED"]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    inFlightRef.current = false;
    startedAtRef.current = null;
    setJobId(null);
  }, [clearTimer]);

  const scheduleMs = () => {
    const jitter = POLL_INTERVAL_MS * POLL_JITTER_RATIO;
    return Math.max(750, Math.floor(POLL_INTERVAL_MS + (Math.random() * 2 - 1) * jitter));
  };

  useEffect(() => {
    clearTimer();
    if (!jobId) return;

    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (startedAtRef.current && Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
        setStatus("FAILED");
        setErrorMessage("Generation timed out. Make sure the worker is running and try again.");
        stop();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }
      if (!inFlightRef.current) {
        inFlightRef.current = true;
        fetcher.load(`/app/api/job/${jobId}`);
      }
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };
    tick();
    return () => {
      stopped = true;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, clearTimer]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    inFlightRef.current = false;
    if (!fetcher.data) return;

    const next: PollStatus = fetcher.data.status ?? "IDLE";
    setStatus(next);
    setErrorMessage(fetcher.data.errorMessage ?? null);
    if (fetcher.data.result) setResult(fetcher.data.result);
    if (TERMINAL.has(next)) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const startPolling = useCallback(
    (id: string) => {
      clearTimer();
      inFlightRef.current = false;
      setResult(null);
      setErrorMessage(null);
      setStatus("PENDING");
      startedAtRef.current = Date.now();
      setJobId(id);
    },
    [clearTimer],
  );

  const reset = useCallback(() => {
    clearTimer();
    inFlightRef.current = false;
    setJobId(null);
    setStatus("IDLE");
    setResult(null);
    setErrorMessage(null);
    startedAtRef.current = null;
  }, [clearTimer]);

  return {
    startPolling,
    reset,
    status,
    result,
    errorMessage,
    isPolling: !!jobId && !TERMINAL.has(status),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function IndexPage() {
  const { product, error, credits } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const suggestFetcher = useFetcher<any>();
  // generateFetcher now only carries the enqueue response { ok, jobId }
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();

  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [localCreditError, setLocalCreditError] = useState<string | null>(null);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);
  // Track optimistic credit spend for the UI counter
  const [creditSpent, setCreditSpent] = useState(0);

  const {
    startPolling,
    reset: resetPolling,
    status: pollStatus,
    result: generationResult,
    errorMessage: pollErrorMessage,
    isPolling,
  } = useJobPoll();

  // ── Wire generate fetcher → start polling ──────────────────────────────────
  useEffect(() => {
    const data = generateFetcher.data;
    if (data?.ok && typeof data?.jobId === "string") {
      startPolling(data.jobId);
      // Optimistically subtract the credit cost so the counter updates instantly
      setCreditSpent((prev) => prev + CREDIT_COSTS.standardGeneration);
    }
  }, [generateFetcher.data?.jobId, startPolling]);

  const isGenerating =
    generateFetcher.state !== "idle" || isPolling;

  const isSuggestingKeywords = suggestFetcher.state !== "idle";
  const isApplying = applyFetcher.state !== "idle";

  const remainingCredits = Math.max(
    0,
    credits.creditsRemaining -
      creditSpent -
      (suggestFetcher.data?.ok === true &&
      suggestFetcher.data?.kind === "suggest_keywords"
        ? CREDIT_COSTS.keywordSuggestion
        : 0),
  );

  const canApply =
    generationResult?.body_html && !isGenerating && !isApplying;

  const actionError =
    localCreditError ??
    (generateFetcher.data?.ok === false
      ? generateFetcher.data.code === "INSUFFICIENT_CREDITS"
        ? "Not enough credits"
        : generateFetcher.data.error
      : null) ??
    (pollStatus === "FAILED" ? pollErrorMessage ?? "Generation failed" : null) ??
    (suggestFetcher.data?.ok === false
      ? suggestFetcher.data.code === "INSUFFICIENT_CREDITS"
        ? "Not enough credits"
        : suggestFetcher.data.error
      : null);

  const suggestedKeywords: string[] =
    suggestFetcher.data?.kind === "suggest_keywords" && suggestFetcher.data?.ok
      ? suggestFetcher.data.keywords
      : [];

  const keywordTags = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const wordCount = generationResult?.body_html
    ? generationResult.body_html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length
    : 0;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(() => {
    if (!product || isGenerating) return;
    if (!hasCredits(remainingCredits, CREDIT_COSTS.standardGeneration)) {
      setLocalCreditError("Not enough credits");
      return;
    }
    setLocalCreditError(null);
    resetPolling();

    const fd = new FormData();
    fd.append("intent", "generate");
    fd.append("productId", product.id);
    fd.append("productTitle", product.title);
    fd.append("vibe", vibe);
    fd.append("format", format);
    fd.append("keywords", keywords);
    fd.append("includeSocials", String(includeSocials));
    generateFetcher.submit(fd, { method: "POST" });
  }, [
    product, isGenerating, remainingCredits, vibe, format, keywords,
    includeSocials, generateFetcher, resetPolling,
  ]);

  const handleSuggestKeywords = useCallback(() => {
    if (!product || isSuggestingKeywords) return;
    if (!hasCredits(remainingCredits, CREDIT_COSTS.keywordSuggestion)) {
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
    suggestFetcher.submit(fd, { method: "POST" });
  }, [product, isSuggestingKeywords, remainingCredits, suggestFetcher]);

  const handleAddSuggestedKeyword = useCallback((kw: string) => {
    setKeywords((prev) => {
      const existing = prev.split(",").map((k) => k.trim()).filter(Boolean);
      if (existing.includes(kw)) return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  const handleKeywordTagRemove = useCallback((kw: string) => {
    setKeywords((prev) =>
      prev.split(",").map((k) => k.trim()).filter((k) => k && k !== kw).join(", "),
    );
  }, []);

  const handleApply = useCallback(() => {
    if (!product || !generationResult) return;
    const fd = new FormData();
    fd.append("intent", "apply");
    fd.append("productId", product.id);
    fd.append("bodyHtml", generationResult.body_html);
    applyFetcher.submit(fd, { method: "POST" });
  }, [product, generationResult, applyFetcher]);

  const handleClear = useCallback(() => {
    setVibe("casual");
    setFormat("paragraph");
    setKeywords("");
    setIncludeSocials(false);
    setLocalCreditError(null);
    setCreditSpent(0);
    resetPolling();
  }, [resetPolling]);

  useEffect(() => {
    if (applyFetcher.data?.ok && applyFetcher.data?.applied) {
      setShowSuccessBanner(true);
      const t = setTimeout(() => setShowSuccessBanner(false), 4000);
      return () => clearTimeout(t);
    }
  }, [applyFetcher.data]);

  const imageUrl = product?.featuredImage?.url ?? DUMMY_IMAGE;

  // ── Error state ─────────────────────────────────────────────────────────────
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

  // ── Render ──────────────────────────────────────────────────────────────────
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
                value: wordCount ? `${wordCount} words` : "—",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="2" y="4" width="16" height="2" rx="1" fill="#5c6ac4" />
                    <rect x="2" y="9" width="12" height="2" rx="1" fill="#5c6ac4" />
                    <rect x="2" y="14" width="14" height="2" rx="1" fill="#5c6ac4" />
                  </svg>
                ),
              },
              {
                label: "Credits left",
                value: String(remainingCredits),
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="10" r="7" stroke="#f59e0b" strokeWidth="2" />
                    <text x="10" y="14" textAnchor="middle" fontSize="9" fill="#f59e0b" fontWeight="bold">$</text>
                  </svg>
                ),
              },
              {
                label: "Current Plan",
                value: credits.creditsLimit > 100 ? "PRO" : "FREE",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="3" y="5" width="14" height="10" rx="2" stroke="#5c6ac4" strokeWidth="2" />
                    <path d="M3 9h14" stroke="#5c6ac4" strokeWidth="1.5" />
                    <rect x="6" y="12" width="4" height="1.5" rx="0.75" fill="#5c6ac4" />
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
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "32px",
                alignItems: "center",
              }}
            >
              {/* Left: steps + CTA */}
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
                    { step: "1. Select Content Type" },
                    { step: "2. Select Target" },
                    { step: "3. Click Generate" },
                  ].map(({ step }) => (
                    <div
                      key={step}
                      style={{
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        padding: "16px 12px",
                        textAlign: "center",
                        background: "#fafbfb",
                        fontSize: "13px",
                        color: "#202223",
                        fontWeight: "500",
                      }}
                    >
                      {step}
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
                  }}
                >
                  ✦ Start Generating
                </button>
              </div>

              {/* Right: preview placeholder */}
              <div
                style={{
                  background: "linear-gradient(135deg, #e8eaff 0%, #f0f4ff 100%)",
                  borderRadius: "10px",
                  aspectRatio: "16/9",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: "80%",
                    background: "#fff",
                    borderRadius: "6px",
                    padding: "10px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                  }}
                >
                  {[60, 90, 75].map((w, i) => (
                    <div
                      key={i}
                      style={{
                        height: i === 0 ? "8px" : "6px",
                        background: "#e1e3e5",
                        borderRadius: "4px",
                        marginBottom: i < 2 ? "6px" : 0,
                        width: `${w}%`,
                      }}
                    />
                  ))}
                </div>
                <div style={{ position: "absolute", bottom: "16px", right: "20px", fontSize: "20px" }}>✨</div>
              </div>
            </div>

            {/* How It Works */}
            <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: "24px" }}>
              <Text as="h2" variant="headingMd" fontWeight="semibold">🚀 How It Works</Text>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: "16px",
                  marginTop: "16px",
                }}
              >
                {[
                  { num: "1", title: "Select a Product", desc: "Choose a product from the table to get started." },
                  { num: "2", title: "Customize Settings", desc: "Adjust tone, length, and other generation options." },
                  { num: "3", title: "Generate Draft", desc: "Click generate — the AI works in the background." },
                  { num: "4", title: "Save to Shopify", desc: "Review the draft and save directly to your store." },
                ].map(({ num, title, desc }) => (
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
                        marginBottom: "8px",
                      }}
                    >
                      {num}
                    </div>
                    <div style={{ fontSize: "13px", fontWeight: "600", color: "#202223", marginBottom: "4px" }}>{title}</div>
                    <div style={{ fontSize: "13px", color: "#6d7175", lineHeight: "1.5" }}>{desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Banners ─────────────────────────────────────────────────────── */}
          {showSuccessBanner && (
            <Banner tone="success" title="Applied to Shopify" onDismiss={() => setShowSuccessBanner(false)}>
              <Text as="p">The product description has been successfully updated in Shopify.</Text>
            </Banner>
          )}

          {actionError && (
            <Banner tone="critical" title="Something went wrong">
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
          />

          {/* ── Main two-column layout ────────────────────────────────────── */}
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
                <Text as="h2" variant="headingSm">Selected Product</Text>

                <Box background="bg-surface-secondary" borderRadius="200">
                  <div style={{ width: "100%", aspectRatio: "1 / 1", overflow: "hidden" }}>
                    <img
                      src={imageUrl}
                      alt={product.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                </Box>

                {product.images.length > 1 && (
                  <InlineStack gap="100" wrap>
                    {product.images.slice(0, 6).map((img, i) => (
                      <div
                        key={img.url + i}
                        style={{
                          width: "48px",
                          height: "48px",
                          borderRadius: "6px",
                          overflow: "hidden",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <img
                          src={img.url}
                          alt={img.altText ?? product.title}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      </div>
                    ))}
                  </InlineStack>
                )}

                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">{product.title}</Text>
                  {product.vendor && (
                    <Text as="p" variant="bodySm" tone="subdued">Vendor: {product.vendor}</Text>
                  )}
                  {product.productType && <Badge>{product.productType}</Badge>}
                  {!product.featuredImage && <Badge tone="warning">Using placeholder image</Badge>}
                </BlockStack>

                <Button fullWidth onClick={() => navigate("/app/products")}>Change Product</Button>
              </BlockStack>
            </Card>

            {/* ── RIGHT: Settings + Output ───────────────────────────────── */}
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Generation Settings</Text>

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
                            !hasCredits(remainingCredits, CREDIT_COSTS.keywordSuggestion)
                          }
                        >
                          Suggest
                        </Button>
                      }
                    />

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
                        <Text as="p" variant="bodySm" tone="subdued">Suggested — click to add:</Text>
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
                      !hasCredits(remainingCredits, CREDIT_COSTS.standardGeneration)
                    }
                  >
                    {isPolling
                      ? pollStatus === "PROCESSING"
                        ? "AI is writing…"
                        : "Queued…"
                      : "Generate Description"}
                  </Button>

                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">Credit cost</Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(CREDIT_COSTS.standardGeneration)} credit
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">Credits remaining</Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(remainingCredits)}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* ── Output Card ──────────────────────────────────────────── */}
              <Card>
                <BlockStack gap="300">
                  <Text as="p" variant="headingSm">Generated Output</Text>
                  <Divider />

                  {/* Polling states */}
                  {isGenerating && !generationResult && (
                    <BlockStack gap="300">
                      <InlineStack gap="300" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="p" tone="subdued">
                          {generateFetcher.state !== "idle"
                            ? "Queuing your request…"
                            : pollStatus === "PROCESSING"
                            ? "AI is writing your description…"
                            : "Waiting for a worker to pick up the job…"}
                        </Text>
                      </InlineStack>
                      {/* Progress bar */}
                      <div
                        style={{
                          height: "4px",
                          background: "#e1e3e5",
                          borderRadius: "2px",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            background: "linear-gradient(90deg, #5c6ac4, #8c9cff)",
                            borderRadius: "2px",
                            width: pollStatus === "PROCESSING" ? "70%" : "20%",
                            transition: "width 0.8s ease",
                          }}
                        />
                      </div>
                    </BlockStack>
                  )}

                  {pollStatus === "CANCELLED" && (
                    <Banner tone="warning" title="Generation cancelled">
                      The job was cancelled before it completed.
                    </Banner>
                  )}

                  {/* Result */}
                  {generationResult ? (
                    <BlockStack gap="400">
                      <div
                        dangerouslySetInnerHTML={{ __html: generationResult.body_html }}
                        style={{ lineHeight: "1.6" }}
                      />

                      {generationResult.social_caption && (
                        <>
                          <Divider />
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">Instagram Caption</Text>
                            <Text as="p" tone="subdued">{generationResult.social_caption}</Text>
                          </BlockStack>
                        </>
                      )}

                      {/* SEO keywords */}
                      {generationResult.keywords?.length > 0 && (
                        <>
                          <Divider />
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">SEO keywords:</Text>
                            <InlineStack gap="100" wrap>
                              {generationResult.keywords.slice(0, 15).map((kw: string) => (
                                <Badge key={kw} tone="info">{kw}</Badge>
                              ))}
                            </InlineStack>
                          </BlockStack>
                        </>
                      )}

                      {/* SEO meta preview */}
                      {(generationResult.meta_title || generationResult.meta_description) && (
                        <>
                          <Divider />
                          <BlockStack gap="150">
                            <Text as="p" variant="headingSm">SEO Preview</Text>
                            <div
                              style={{
                                padding: "12px 16px",
                                background: "#fff",
                                border: "1px solid #dadce0",
                                borderRadius: "8px",
                                fontFamily: "arial, sans-serif",
                                maxWidth: 540,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 17,
                                  color: "#1a0dab",
                                  marginBottom: 3,
                                  overflow: "hidden",
                                  whiteSpace: "nowrap",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {generationResult.meta_title ?? product.title}
                              </div>
                              <div style={{ fontSize: 13, color: "#006621", marginBottom: 3 }}>
                                {product.vendor || "Shopify"} › products
                              </div>
                              <div style={{ fontSize: 14, color: "#545454" }}>
                                {generationResult.meta_description ?? ""}
                              </div>
                            </div>
                          </BlockStack>
                        </>
                      )}

                      <Divider />

                      <InlineStack gap="400" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">{wordCount}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">Words</Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">{vibe}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">Style</Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingMd">{format}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">Format</Text>
                        </BlockStack>
                        <Button
                          variant="primary"
                          tone="success"
                          disabled={!canApply}
                          loading={isApplying}
                          onClick={handleApply}
                        >
                          Apply to Shopify
                        </Button>
                        <Button variant="tertiary" tone="critical" onClick={handleClear}>
                          Clear
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  ) : !isGenerating ? (
                    <Text as="p" tone="subdued">
                      Configure settings above and click "Generate Description" to create an
                      AI-powered product description.
                    </Text>
                  ) : null}
                </BlockStack>
              </Card>
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}