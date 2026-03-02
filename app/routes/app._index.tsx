// FILE: app/routes/app.index.tsx

import { useState, useCallback } from "react";
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
  Checkbox,
  Banner,
  Tag,
} from "@shopify/polaris";

import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { suggestKeywords } from "../lib/deepseek.server";

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
  const { admin } = await authenticate.admin(request);

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
// Action — suggest_keywords | generate
// ─────────────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "suggest_keywords") {
    const title = String(form.get("title") ?? "");
    const vendor = String(form.get("vendor") ?? "");
    const productType = String(form.get("productType") ?? "");
    const tags = String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const keywords = await suggestKeywords(title, vendor, productType, tags);
      return json({ ok: true, kind: "suggest_keywords", keywords });
    } catch (err) {
      return json(
        { ok: false, kind: "error", error: "Failed to suggest keywords" },
        { status: 500 },
      );
    }
  }

  if (intent === "generate") {
    const productId = String(form.get("productId") ?? "");
    const vibe = String(form.get("vibe") ?? "casual").slice(0, 40);
    const format = String(form.get("format") ?? "paragraph").slice(0, 40);
    const keywords = String(form.get("keywords") ?? "").slice(0, 500);
    const includeSocials = form.get("includeSocials") === "true";

    // Fetch product title server-side (never trust client)
    try {
      const resp = await admin.graphql(
        `#graphql
        query ProductTitle($id: ID!) {
          product(id: $id) { title vendor productType tags }
        }`,
        { variables: { id: productId } },
      );
      const data = await resp.json();
      const p = data?.data?.product;
      if (!p) {
        return json(
          { ok: false, kind: "error", error: "Product not found" },
          { status: 404 },
        );
      }

      // TODO: wire to your real enqueue / AI generation pipeline
      // For now returning a structured mock matching DraftResult shape
      const mockDescription = `
        <p>Discover the <strong>${p.title}</strong> — crafted for those who value ${vibe} quality.
        ${keywords ? `Featuring: ${keywords}.` : ""}
        Perfect for everyday use, this product brings together premium materials and thoughtful design.</p>
        ${
          format === "bullets" || format === "hybrid"
            ? `<ul><li>Premium quality materials</li><li>Thoughtfully designed</li><li>Built to last</li></ul>`
            : ""
        }
        ${includeSocials ? `<p><em>Instagram: You need this in your life ✨ #${p.title.replace(/\s+/g, "")} #${vibe}</em></p>` : ""}
      `.trim();

      const wordCount = mockDescription
        .replace(/<[^>]+>/g, " ")
        .trim()
        .split(/\s+/).length;
      const charCount = mockDescription.replace(/<[^>]+>/g, "").length;

      return json({
        ok: true,
        kind: "generate",
        result: {
          body_html: mockDescription,
          headline: `${p.title} — ${vibe.charAt(0).toUpperCase() + vibe.slice(1)} Edition`,
          social_caption: includeSocials
            ? `You need this in your life ✨ #${p.title.replace(/\s+/g, "")}`
            : undefined,
          keywords: keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          primary_keyword: keywords.split(",")[0]?.trim() ?? "",
          wordCount,
          charCount,
        },
      });
    } catch (err) {
      return json(
        { ok: false, kind: "error", error: "Generation failed" },
        { status: 500 },
      );
    }
  }
  if (intent === "apply") {
    const productId = String(form.get("productId") ?? "");
    const bodyHtml = String(form.get("bodyHtml") ?? "");

    if (!productId || !bodyHtml) {
      return json(
        { ok: false, error: "Missing product or description" },
        { status: 400 },
      );
    }

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
  {
    variables: {
      id: productId,
      descriptionHtml: bodyHtml,
    },
  }
);

// convert response to JSON
const result = await response.json();

// extract userErrors
const userErrors = result?.data?.productUpdate?.userErrors;

// if Shopify rejected update
if (userErrors && userErrors.length > 0) {
  return json(
    { ok: false, error: userErrors[0].message },
    { status: 400 }
  );
}

// only if no errors:
return json({ ok: true, applied: true });
}

// If no valid intent matched
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
  const fetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();

  // Settings state
  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isSuggestingKeywords =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "suggest_keywords";

  const generationResult =
    fetcher.data?.kind === "generate" && fetcher.data?.ok
      ? fetcher.data.result
      : null;

  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;

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
    fetcher.submit(fd, { method: "POST" });
  }, [product, vibe, format, keywords, includeSocials, fetcher]);

  const handleSuggestKeywords = useCallback(() => {
    if (!product) return;
    const fd = new FormData();
    fd.append("intent", "suggest_keywords");
    fd.append("title", product.title);
    fd.append("vendor", product.vendor);
    fd.append("productType", product.productType);
    fd.append("tags", product.tags.join(","));
    fetcher.submit(fd, { method: "POST" });
  }, [product, fetcher]);

  const handleKeywordTagRemove = useCallback((kw: string) => {
    setKeywords((prev) =>
      prev
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k && k !== kw)
        .join(", "),
    );
  }, []);

  // Inject suggested keywords when they arrive
  const suggestedKeywords: string[] =
    fetcher.data?.kind === "suggest_keywords" && fetcher.data?.ok
      ? fetcher.data.keywords
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

  // ── Derived ───────────────────────────────────────────────────────────────

  const imageUrl = product?.featuredImage?.url ?? DUMMY_IMAGE;

  const keywordTags = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // ── Render ────────────────────────────────────────────────────────────────

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
    <Page
      title="DescribeAI"
      subtitle="AI Product Description Generator"
      primaryAction={{
        content: "Generate Description",
        onAction: handleGenerate,
        loading: isGenerating,
        disabled: isGenerating || isSuggestingKeywords,
      }}
    >
      <Layout>
        <Layout.Section>
          {actionError && (
            <Banner tone="critical" title="Something went wrong">
              <Text as="p">{actionError}</Text>
            </Banner>
          )}

          {applyFetcher.data?.ok && applyFetcher.data?.applied && (
            <Banner tone="success" title="Applied to Shopify">
              <Text as="p">
                The product description has been successfully updated in
                Shopify.
              </Text>
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
                  overflow="hidden"
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
                  <Text variant="bodySm" tone="subdued">
                    /products/{product.handle}
                  </Text>
                  {product.vendor && (
                    <Text variant="bodySm" tone="subdued">
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
                        <Text variant="bodySm" tone="subdued">
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

                  <Checkbox
                    label="Include Instagram caption"
                    checked={includeSocials}
                    onChange={setIncludeSocials}
                    disabled={isGenerating}
                  />
                </BlockStack>
              </Card>

              {/* Generated Output */}
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm">Generated Output</Text>
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
                            <Text variant="headingSm">Instagram Caption</Text>
                            <Text as="p" tone="subdued">
                              {generationResult.social_caption}
                            </Text>
                          </BlockStack>
                        </>
                      )}

                      <Divider />

                      <InlineStack gap="600">
                        <BlockStack gap="050">
                          <Text variant="headingMd">
                            {generationResult.wordCount}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            Words
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">
                            {generationResult.charCount}
                          </Text>
                          <Text variant="bodySm" tone="subdued">
                            Characters
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">{vibe}</Text>
                          <Text variant="bodySm" tone="subdued">
                            Style
                          </Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">{format}</Text>
                          <Text variant="bodySm" tone="subdued">
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
                      </InlineStack>

                      {generationResult.primary_keyword && (
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodySm" tone="subdued">
                            Primary keyword:
                          </Text>
                          <Badge>{generationResult.primary_keyword}</Badge>
                        </InlineStack>
                      )}
                    </BlockStack>
                  ) : (
                    <Text tone="subdued">
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
