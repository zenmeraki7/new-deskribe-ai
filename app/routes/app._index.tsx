import crypto from "node:crypto";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
  Badge,
  Select,
  TextField,
  Divider,
  Spinner,
  Box,
  Banner,
  Tag,
  Tabs,
  Thumbnail,
  SkeletonBodyText,
  Frame,
  Toast,
  Tooltip,
  Icon,
  EmptyState,
  List,
} from "@shopify/polaris";
import { ImageIcon, MagicIcon } from "@shopify/polaris-icons";

import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { suggestKeywords } from "../lib/ai.server";
import { requireAdminSession } from "../lib/auth.server";
import {
  checkAndIncrementKeywordLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
// import { CREDIT_COSTS } from "../lib/credits";
import { CreditUsageCard } from "../components/CreditUsageCard";
import { formatCredits, hasCredits, CREDIT_COSTS } from "../lib/credits";
import { db } from "../lib/db.server";
import { generationQueue } from "../lib/queue.server";
import { checkBilling } from "../lib/billing.server";

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
  "IDLE" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface DraftResult {
  body_html: string;
  meta_title: string;
  meta_description: string;
  keywords: string[];
  social_caption?: string;
}

function formatShopifyGraphQLErrors(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }

  const messages = errors
    .map((error) =>
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : null,
    )
    .filter(Boolean);

  return messages.length > 0 ? messages.join("; ") : null;
}

async function formatCaughtError(error: unknown): Promise<string> {
  if (error instanceof Error) {
    return error.message;
  }

  if (error instanceof Response) {
    const body = await error.text().catch(() => "");
    const details = body.trim() ? `: ${body.slice(0, 300)}` : "";

    return `HTTP ${error.status} ${error.statusText || "Response"}${details}`;
  }

  return String(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — plain read, no transaction, no lock (UNCHANGED)
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { admin, shopDomain } = await requireAdminSession(request);

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

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

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Shopify product query failed with HTTP ${resp.status}: ${body.slice(0, 300)}`,
      );
    }

    const data: any = await resp.json();
    const graphQLError = formatShopifyGraphQLErrors(data?.errors);

    if (graphQLError) {
      throw new Error(graphQLError);
    }

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
    const errorMessage = await formatCaughtError(err);

    console.error("[home] Failed to load Shopify product:", err);

    return json<LoaderData>({
      product: null,
      credits: {
        creditsUsed: credits.creditsUsed,
        creditsLimit: credits.creditsLimit,
        creditsRemaining: credits.creditsRemaining,
        resetDate: credits.resetDate.toISOString(),
      },
      error: errorMessage || "Failed to load product.",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { deductCredits, refundCredits } =
    await import("../lib/creditService.server");
  const { admin, shopDomain } = await requireAdminSession(request);
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

    const { appSubscriptions } = await checkBilling(admin.graphql);
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
  if (intent === "generate") {
    let creditRequestId: string | null = null;
    let plan = resolvePlan(null);

    try {
      const { appSubscriptions } = await checkBilling(admin.graphql);
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
        const msg =
          typeof enqueueErr?.message === "string" ? enqueueErr.message : "";
        if (!(msg.includes("Job") && msg.includes("already exists"))) {
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
            {
              ok: false,
              kind: "error",
              error: "Failed to queue generation. Please try again.",
            },
            { status: 503 },
          );
        }
      }

      // ── 6. Return jobId immediately — UI will poll ────────────────────────
      return json({ ok: true, kind: "generate", jobId: job.id });
    } catch (err) {
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
// Polling hook — UNCHANGED
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
  const jobIdRef = useRef<string | null>(null);

  const [status, setStatus] = useState<PollStatus>("IDLE");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

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
    jobIdRef.current = null;
    setIsPolling(false);
  }, [clearTimer]);

  const scheduleMs = () => {
    const jitter = POLL_INTERVAL_MS * POLL_JITTER_RATIO;
    return Math.max(
      750,
      Math.floor(POLL_INTERVAL_MS + (Math.random() * 2 - 1) * jitter),
    );
  };

  useEffect(() => {
    if (!isPolling) return;
    clearTimer();

    let stopped = false;
    const tick = () => {
      if (stopped || !jobIdRef.current) return;
      if (
        startedAtRef.current &&
        Date.now() - startedAtRef.current > POLL_TIMEOUT_MS
      ) {
        setStatus("FAILED");
        setErrorMessage(
          "Generation timed out. Make sure the worker is running and try again.",
        );
        stop();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }
      if (!inFlightRef.current) {
        inFlightRef.current = true;
        fetcher.load(`/app/api/job/${jobIdRef.current}`);
      }
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };
    tick();
    return () => {
      stopped = true;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPolling, clearTimer]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    inFlightRef.current = false;
    if (!fetcher.data) return;

    const next: PollStatus = fetcher.data.status ?? "IDLE";
    setStatus(next);
    setErrorMessage(fetcher.data.errorMessage ?? null);

    if (fetcher.data.result) {
      setResult(fetcher.data.result);
    }

    if (TERMINAL.has(next)) {
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const startPolling = useCallback(
    (id: string) => {
      clearTimer();
      inFlightRef.current = false;
      jobIdRef.current = id;
      setResult(null);
      setErrorMessage(null);
      setStatus("PENDING");
      startedAtRef.current = Date.now();
      setIsPolling(true);
    },
    [clearTimer],
  );

  const reset = useCallback(() => {
    clearTimer();
    inFlightRef.current = false;
    jobIdRef.current = null;
    setStatus("IDLE");
    setResult(null);
    setErrorMessage(null);
    setIsPolling(false);
    startedAtRef.current = null;
  }, [clearTimer]);

  return {
    startPolling,
    reset,
    status,
    result,
    errorMessage,
    isPolling,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component — same handlers/state as before. Everything below is rendered
// with Polaris components and Polaris-supported props only (Box tokens for
// spacing/border/radius/background, BlockStack `align` for layout — no
// stylesheet, no re-themed CSS variables, no custom classNames).
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
  const [creditSpent, setCreditSpent] = useState(0);

  // UI-only, not sent to the server
  const [selectedTab, setSelectedTab] = useState(0);
  const [altTextDrafts, setAltTextDrafts] = useState<Record<string, string>>(
    {},
  );

  const {
    startPolling,
    reset: resetPolling,
    status: pollStatus,
    result: generationResult,
    errorMessage: pollErrorMessage,
    isPolling,
  } = useJobPoll();

  useEffect(() => {
    const data = generateFetcher.data;
    if (data?.ok && typeof data?.jobId === "string") {
      startPolling(data.jobId);
      setCreditSpent((prev) => prev + CREDIT_COSTS.standardGeneration);
    }
  }, [generateFetcher.data?.jobId, startPolling]);

  const isGenerating = generateFetcher.state !== "idle" || isPolling;

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

  const canApply = generationResult?.body_html && !isGenerating && !isApplying;

  const actionError =
    localCreditError ??
    (generateFetcher.data?.ok === false
      ? generateFetcher.data.code === "INSUFFICIENT_CREDITS"
        ? "Not enough credits"
        : generateFetcher.data.error
      : null) ??
    (pollStatus === "FAILED"
      ? (pollErrorMessage ?? "Generation failed")
      : null) ??
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
    ? generationResult.body_html
        .replace(/<[^>]+>/g, " ")
        .trim()
        .split(/\s+/).length
    : 0;

  // ── Handlers — same bodies as the original ─────────────────────────────────

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
    product,
    isGenerating,
    remainingCredits,
    vibe,
    format,
    keywords,
    includeSocials,
    generateFetcher,
    resetPolling,
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
      const existing = prev
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (existing.includes(kw)) return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  const handleKeywordTagRemove = useCallback((kw: string) => {
    setKeywords((prev) =>
      prev
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k && k !== kw)
        .join(", "),
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

  const tabs = [
    { id: "description", content: "Description" },
    { id: "seo-social", content: "SEO & social" },
    {
      id: "alt-text",
      content: product
        ? `Image alt text (${product.images.length})`
        : "Image alt text",
    },
  ];

  // ── Error state — unchanged logic ───────────────────────────────────────────
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
    <Frame>
      <Page>
        <Layout>
          {/* ── Header ─────────────────────────────────────────────────────── */}
          <Layout.Section>
            <InlineStack gap="300" blockAlign="center">
              <BlockStack gap="0">
                <Text as="h1" variant="headingLg">
                  DescribeAI
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  AI Product Description Generator
                </Text>
              </BlockStack>
            </InlineStack>
          </Layout.Section>

          {actionError && (
            <Layout.Section>
              <Banner tone="critical" title="Something went wrong">
                <Text as="p">{actionError}</Text>
              </Banner>
            </Layout.Section>
          )}

          {applyFetcher.data?.ok === false && applyFetcher.data?.error && (
            <Layout.Section>
              <Banner tone="critical" title="Failed to apply description">
                <Text as="p">{applyFetcher.data.error}</Text>
              </Banner>
            </Layout.Section>
          )}

          {/* ── Credits + Product + Settings ─────────────────────────────────── */}
          <Layout.Section>
            <Card padding="0">
              <Box padding="0">
                <CreditUsageCard
                  compact
                  title="Credits remaining"
                  creditsUsed={credits.creditsLimit - remainingCredits}
                  creditsLimit={credits.creditsLimit}
                  creditsRemaining={remainingCredits}
                />
              </Box>

              <Divider />

              <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }}>
                {/* ── Selected Product ─────────────────────────────────── */}
                <Box
                  padding="400"
                  borderInlineEndWidth={{ md: "025" }}
                  borderColor="border"
                  borderBlockEndWidth={{ xs: "025", md: "0" }}
                >
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingSm">
                      Selected Product
                    </Text>

                    <Box
                      borderRadius="300"
                      borderWidth="025"
                      borderColor="border-brand"
                      overflowX="hidden"
                      overflowY="hidden"
                    >
                      <img
                        src={imageUrl}
                        alt={product.title}
                        style={{
                          width: "100%",
                          aspectRatio: "1 / 1",
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    </Box>

                    {product.images.length > 1 && (
                      <InlineStack gap="150" wrap>
                        {product.images.slice(0, 6).map((img, i) => (
                          <Thumbnail
                            key={img.url + i}
                            source={img.url || ImageIcon}
                            alt={img.altText ?? product.title}
                            size="small"
                          />
                        ))}
                      </InlineStack>
                    )}

                    <BlockStack gap="100">
                      <Tooltip content={product.title}>
                        <Text variant="headingMd" as="h3" truncate>
                          {product.title}
                        </Text>
                      </Tooltip>
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
                </Box>

                {/* ── Generation Settings ──────────────────────────────── */}
                <Box padding="400">
                  <BlockStack gap="400" align="space-between">
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
                                  CREDIT_COSTS.keywordSuggestion,
                                )
                              }
                            >
                              Suggest
                            </Button>
                          }
                        />

                        {keywordTags.length > 0 && (
                          <InlineStack gap="100" wrap>
                            {keywordTags.map((kw) => (
                              <Tag
                                key={kw}
                                onRemove={() => handleKeywordTagRemove(kw)}
                              >
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
                                <Button
                                  key={kw}
                                  size="micro"
                                  onClick={() => handleAddSuggestedKeyword(kw)}
                                >
                                  + {kw}
                                </Button>
                              ))}
                            </InlineStack>
                          </BlockStack>
                        )}
                      </BlockStack>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Divider />
                      <Box
                        background="bg-surface-secondary"
                        borderRadius="300"
                        padding="300"
                      >
                        <BlockStack gap="200">
                          <Text as="h4" variant="headingXs">
                            How it works
                          </Text>
                          <List type="number">
                            <List.Item>
                              Pick a writing style and format for the
                              description.
                            </List.Item>
                            <List.Item>
                              Add your own keywords, or hit "Suggest" to let AI
                              pull relevant ones from the product's title,
                              vendor, and tags.
                            </List.Item>
                            <List.Item>
                              Click "Generate Description" — this uses{" "}
                              {formatCredits(CREDIT_COSTS.standardGeneration)}{" "}
                              credit and usually finishes in a few seconds.
                            </List.Item>
                            <List.Item>
                              Review the draft, SEO preview, and social caption
                              in the tabs below, then apply it straight to the
                              product.
                            </List.Item>
                          </List>
                        </BlockStack>
                      </Box>
                    </BlockStack>

                    <BlockStack gap="300">
                      <Divider />
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">
                            Credit cost
                          </Text>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            {formatCredits(CREDIT_COSTS.standardGeneration)}{" "}
                            credit
                          </Text>
                        </BlockStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {formatCredits(remainingCredits)} remaining
                        </Text>
                        <Button
                          variant="primary"
                          tone="success"
                          onClick={handleGenerate}
                          loading={isGenerating}
                          disabled={
                            isGenerating ||
                            isSuggestingKeywords ||
                            !hasCredits(
                              remainingCredits,
                              CREDIT_COSTS.standardGeneration,
                            )
                          }
                        >
                          {isPolling
                            ? pollStatus === "PROCESSING"
                              ? "AI is writing…"
                              : "Queued…"
                            : "Generate Description"}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Box>
              </InlineGrid>
            </Card>
          </Layout.Section>

          {/* ── Output Card ──────────────────────────────────────────── */}
          <Layout.Section>
            <Card padding="0">
              <Tabs
                tabs={tabs}
                selected={selectedTab}
                onSelect={setSelectedTab}
              />
              <Box padding="400">
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
                    <SkeletonBodyText lines={4} />
                  </BlockStack>
                )}

                {pollStatus === "CANCELLED" && (
                  <Banner tone="warning" title="Generation cancelled">
                    The job was cancelled before it completed.
                  </Banner>
                )}

                {!isGenerating && !generationResult && selectedTab !== 2 && (
                  <BlockStack gap="400" align="center" inlineAlign="center">
                    <Box
                      background="bg-fill-magic-secondary"
                      borderRadius="full"
                      padding="500"
                    >
                      <Icon source={MagicIcon} tone="magic" />
                    </Box>
                    <BlockStack gap="150" inlineAlign="center">
                      <Text as="h3" variant="headingSm" alignment="center">
                        Nothing generated yet
                      </Text>
                      <Text as="p" tone="subdued" alignment="center">
                        Configure settings above, then generate a description
                        for "{product.title}".
                      </Text>
                    </BlockStack>
                    <Button
                      variant="primary"
                      tone="success"
                      onClick={handleGenerate}
                      disabled={
                        !hasCredits(
                          remainingCredits,
                          CREDIT_COSTS.standardGeneration,
                        )
                      }
                    >
                      Generate Description
                    </Button>
                  </BlockStack>
                )}

                {/* ── Tab 0: Description ──────────────────────────────── */}
                {generationResult && selectedTab === 0 && (
                  <BlockStack gap="400">
                    <div
                      dangerouslySetInnerHTML={{
                        __html: generationResult.body_html,
                      }}
                    />
                    <Divider />
                    <InlineStack gap="400">
                      <BlockStack gap="050">
                        <Text as="p" variant="headingMd">
                          {wordCount}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Words
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="headingMd">
                          {vibe}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Style
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="headingMd">
                          {format}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Format
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </BlockStack>
                )}

                {/* ── Tab 1: SEO & social ──────────────────────────────── */}
                {generationResult && selectedTab === 1 && (
                  <BlockStack gap="400">
                    {(generationResult.meta_title ||
                      generationResult.meta_description) && (
                      <BlockStack gap="150">
                        <Text as="p" variant="headingSm">
                          SEO Preview
                        </Text>
                        {/* Google SERP mockup: colors here mimic Google's own
                            result styling, not app branding — Polaris has no
                            component for this, so plain inline styles are used
                            only for this one snippet. */}
                        <Box
                          padding="400"
                          borderWidth="025"
                          borderColor="border"
                          borderRadius="300"
                          background="bg-surface"
                        >
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyLg" truncate>
                              {generationResult.meta_title ?? product.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="success">
                              {product.vendor || "Shopify"} › products
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {generationResult.meta_description ?? ""}
                            </Text>
                          </BlockStack>
                        </Box>
                      </BlockStack>
                    )}

                    {generationResult.keywords?.length > 0 && (
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">
                          SEO keywords:
                        </Text>
                        <InlineStack gap="100" wrap>
                          {generationResult.keywords
                            .slice(0, 15)
                            .map((kw: string) => (
                              <Badge key={kw} tone="info">
                                {kw}
                              </Badge>
                            ))}
                        </InlineStack>
                      </BlockStack>
                    )}

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
                  </BlockStack>
                )}

                {/* ── Tab 2: Image alt text (UI-only, no backend call) ─── */}
                {selectedTab === 2 && (
                  <BlockStack gap="300">
                    <Banner tone="info">
                      AI-generated alt text isn't wired up yet — that needs a
                      backend change to `action`. You can still write alt text
                      manually below.
                    </Banner>
                    {product.images.map((img, i) => (
                      <InlineStack
                        key={img.url + i}
                        gap="300"
                        blockAlign="start"
                        wrap={false}
                      >
                        <Thumbnail
                          source={img.url || ImageIcon}
                          alt={img.altText ?? ""}
                          size="large"
                        />
                        <div style={{ flex: 1 }}>
                          <TextField
                            label={`Image ${i + 1} alt text`}
                            labelHidden
                            value={altTextDrafts[img.url] ?? img.altText ?? ""}
                            onChange={(val) =>
                              setAltTextDrafts((prev) => ({
                                ...prev,
                                [img.url]: val,
                              }))
                            }
                            placeholder="Describe this image for accessibility & SEO"
                            autoComplete="off"
                            multiline={2}
                          />
                        </div>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                {generationResult && selectedTab !== 2 && (
                  <>
                    <Divider />
                    <Box paddingBlockStart="400">
                      <InlineStack align="end" gap="200">
                        <Button
                          variant="tertiary"
                          tone="critical"
                          onClick={handleClear}
                        >
                          Clear
                        </Button>
                        <Button
                          variant="primary"
                          tone="success"
                          disabled={!canApply}
                          loading={isApplying}
                          onClick={handleApply}
                        >
                          Apply to Shopify
                        </Button>
                      </InlineStack>
                    </Box>
                  </>
                )}
              </Box>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>

      {showSuccessBanner && (
        <Toast
          content="Applied to Shopify"
          onDismiss={() => setShowSuccessBanner(false)}
        />
      )}
    </Frame>
  );
}
