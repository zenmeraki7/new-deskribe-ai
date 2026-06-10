// FILE: app/routes/app.index.tsx

import crypto from "node:crypto";
import { useState, useCallback, useEffect } from "react";
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
  List,
} from "@shopify/polaris";

import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
// AFTER
import { json, redirect } from "@remix-run/node";
import {
  suggestKeywords,
  generateProductDescription,
} from "../lib/ai.server";
import { authenticate } from "../shopify.server";
import {
  checkAndIncrementKeywordLimit,
  checkAndIncrementRateLimit,
  resolvePlan,
} from "../lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, refundCredits } from "../lib/creditService.server";


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
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — fetch first product from Shopify
// ─────────────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, billing, session } = await authenticate.admin(request);

  // Safe billing check — don't crash if it fails
  try {
   const { hasActivePayment } = await billing.check();

    if (!hasActivePayment) {
       throw redirect(`https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing`);
}
  
  } catch (err) {
    // If it's a redirect, let it through
    if (err instanceof Response) throw err;
    // Otherwise log and continue — don't crash the app
    console.error("[billing.check error]", err);
  }
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
            featuredImage {
              url
            }
          }
        }
      }
    `);

    const data = await resp.json();
    const product: ShopifyProduct | null =
      data?.data?.products?.nodes?.[0] ?? null;

    return json<LoaderData>({ product });
  } catch (err) {
    return json<LoaderData>({
      product: null,
      error: "Failed to load product.",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — suggest_keywords | generate | apply
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── suggest_keywords ──────────────────────────────────────────────────────
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
    const rate = await checkAndIncrementKeywordLimit(session.shop, plan);
    if (!rate.allowed) {
      return json(
        {
          ok: false,
          kind: "error",
          code: rate.reason === "global_limit" ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
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
      shopId: session.shop,
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
        shopId: session.shop,
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
          error: err instanceof Error ? err.message : "Keyword generation failed",
        },
        { status: 500 },
      );
    }
  }

  // ── generate ──────────────────────────────────────────────────────────────
  if (intent === "generate") {
    let creditRequestId: string | null = null;
    let plan = resolvePlan(null);
    try {
      const { appSubscriptions } = await billing.check();
      plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
      const rate = await checkAndIncrementRateLimit(session.shop, plan);
      if (!rate.allowed) {
        return json(
          {
            ok: false,
            kind: "error",
            code: rate.reason === "global_limit" ? "GLOBAL_LIMIT_REACHED" : "RATE_LIMIT_EXCEEDED",
            error:
              rate.reason === "global_limit"
                ? "Service is temporarily at capacity. Please try again in a few hours."
                : "Too many generation requests. Please try again in a minute.",
          },
          { status: 429 },
        );
      }

      const productId = String(form.get("productId") ?? "");
      const vibe = String(form.get("vibe") ?? "casual");
      const format = String(form.get("format") ?? "paragraph");
      const keywords = String(form.get("keywords") ?? "");
      const includeSocials = form.get("includeSocials") === "true";

      const resp = await admin.graphql(
        `query ProductTitle($id: ID!) {
          product(id: $id) { title vendor productType tags }
        }`,
        { variables: { id: productId } },
      );

      const data = await resp.json();
      const p = data?.data?.product;

      if (!p) {
        return json(
          { ok: false, kind: "error", error: "Product not found." },
          { status: 404 },
        );
      }

      creditRequestId = crypto.randomUUID();
      const credit = await deductCredits({
        shopId: session.shop,
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

      const result = await generateProductDescription({
        title: p.title,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        vibe,
        format,
        keywords: keywords.split(",").map((k: string) => k.trim()).filter(Boolean),
        includeSocials,
      });

      const wordCount = result.body_html
        .replace(/<[^>]+>/g, " ")
        .trim()
        .split(/\s+/).length;
      const charCount = result.body_html.replace(/<[^>]+>/g, "").length;

      return json({
        ok: true,
        kind: "generate",
        result: {
          ...result,
          headline: `${p.title} — ${vibe}`,
          wordCount,
          charCount,
          primary_keyword: result.keywords?.[0] ?? "",
        },
      });
    } catch (err) {
      if (creditRequestId) {
        await refundCredits({
          shopId: session.shop,
          plan,
          amount: CREDIT_COSTS.standardGeneration,
          requestId: `${creditRequestId}:failed`,
          metadata: { intent: "index_generate" },
        });
      }
      console.error("Generation error:", err);
      return json(
        {
          ok: false,
          kind: "error",
          error: err instanceof Error ? err.message : "Description generation failed",
        },
        { status: 500 },
      );
    }
  }

  // ── apply ─────────────────────────────────────────────────────────────────
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
          productUpdate(input: {
            id: $id,
            descriptionHtml: $descriptionHtml
          }) {
            product { id }
            userErrors { field message }
          }
        }`,
        { variables: { id: productId, descriptionHtml: bodyHtml } },
      );

      const result = await response.json();
      const userErrors = result?.data?.productUpdate?.userErrors;

      if (userErrors && userErrors.length > 0) {
        return json({ ok: false, error: userErrors[0].message }, { status: 400 });
      }

      return json({ ok: true, applied: true });
    } catch (err) {
      console.error("Apply error:", err);
      return json(
        { ok: false, error: err instanceof Error ? err.message : "Failed to apply description" },
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
  const { product, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // FIX: Separate fetchers for suggest and generate to avoid state conflicts
  const suggestFetcher = useFetcher<any>();
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();

  // Settings state
  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);

  // FIX: showSuccessBanner is now properly wired
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const isGenerating = generateFetcher.state !== "idle";
  const isSuggestingKeywords = suggestFetcher.state !== "idle";

  const generationResult =
    generateFetcher.data?.kind === "generate" && generateFetcher.data?.ok
      ? generateFetcher.data.result
      : null;

  // Show errors from either fetcher
  const actionError =
    (generateFetcher.data?.ok === false ? generateFetcher.data.error : null) ??
    (suggestFetcher.data?.ok === false ? suggestFetcher.data.error : null);

  const isApplying = applyFetcher.state !== "idle";

  const canApply =
    generationResult &&
    generationResult.body_html &&
    !isGenerating &&
    !isApplying;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(() => {
    if (!product) return;
    const fd = new FormData();
    fd.append("intent", "generate");
    fd.append("productId", product.id);
    fd.append("vibe", vibe);
    fd.append("format", format);
    fd.append("keywords", keywords);
    fd.append("includeSocials", String(includeSocials));
    generateFetcher.submit(fd, { method: "POST" });
  }, [product, vibe, format, keywords, includeSocials, generateFetcher]);

  const handleSuggestKeywords = useCallback(() => {
    if (!product) return;
    const fd = new FormData();
    fd.append("intent", "suggest_keywords");
    fd.append("title", product.title);
    fd.append("vendor", product.vendor);
    fd.append("productType", product.productType);
    fd.append("tags", product.tags.join(","));
    suggestFetcher.submit(fd, { method: "POST" });
  }, [product, suggestFetcher]);

  const handleKeywordTagRemove = useCallback((kw: string) => {
    setKeywords((prev) =>
      prev
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k && k !== kw)
        .join(", "),
    );
  }, []);

  // FIX: showSuccessBanner is now properly set and auto-dismissed
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
      const existing = prev
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
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

  // ── Derived ───────────────────────────────────────────────────────────────

  const imageUrl = product?.featuredImage?.url ?? DUMMY_IMAGE;

  const keywordTags = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // ── Render ────────────────────────────────────────────────────────────────

  // FIX: Removed stray success Banner from error branch
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
          {/* FIX: Success banner uses showSuccessBanner state */}
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

                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
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
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  </div>
                </Box>

                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">
                    {product.title}
                  </Text>
                  {/* <Text as="p" variant="bodySm" tone="subdued">
{product.handle}
                  </Text> */}
                  {product.vendor && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Vendor: {product.vendor}
                    </Text>
                  )}
                  {product.productType && <Badge>{product.productType}</Badge>}
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
              {/* Generation Settings */}
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

                  {/* Keywords field */}
                  <BlockStack gap="200">
                    <InlineStack
                      gap="200"
                      align="space-between"
                      blockAlign="end"
                    >
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
                            disabled={isGenerating || isSuggestingKeywords}
                          >
                            Suggest
                          </Button>
                        }
                      />
                    </InlineStack>

                    {/* Keyword tags (current) */}
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

                    {/* Suggested keywords */}
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

                  {/* <Checkbox
                    label="Include Instagram caption"
                    checked={includeSocials}
                    onChange={setIncludeSocials}
                    disabled={isGenerating}
                  /> */}

                  <Button
                    variant="primary"
                    tone="success"
                    onClick={handleGenerate}
                    loading={isGenerating}
                    disabled={isGenerating || isSuggestingKeywords}
                  >
                    Generate Description
                  </Button>
                </BlockStack>
              </Card>

              {/* Generated Output */}
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
                              fd.append("productId", product.id);
                              fd.append("bodyHtml", generationResult.body_html);
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

              <div style={{marginBottom:'10px'}}>
              <Card>
                  <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    🚀 How It Works
                  </Text>

                  <List type="number">
                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Select a Product:
                      </Text>{" "}
                      Choose a product from the table to get started.
                    </List.Item>

                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Customize Your Settings:
                      </Text>{" "}
                      Adjust tone, length, and other generation options to match
                      your needs.
                    </List.Item>

                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Generate Draft:
                      </Text>{" "}
                      Click the generate button to create your AI-powered
                      product description.
                    </List.Item>

                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Save to Shopify:
                      </Text>{" "}
                      Review the draft and save it directly to your Shopify
                      store with one click.
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
               </div>
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
