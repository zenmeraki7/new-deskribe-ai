// FILE: app/routes/app.index.tsx

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
  Checkbox,
  Banner,
  Tag,
  List,
} from "@shopify/polaris";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import {
  suggestKeywords,
  generateProductDescription,
} from "../lib/ai.server";
import { authenticate } from "../shopify.server";

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

type ActionData =
  | {
      ok: true;
      kind: "suggest_keywords";
      keywords: string[];
    }
  | {
      ok: true;
      kind: "generate";
      result: {
        body_html: string;
        social_caption?: string;
        keywords?: string[];
        headline: string;
        wordCount: number;
        charCount: number;
        primary_keyword: string;
      };
    }
  | {
      ok: true;
      applied: true;
    }
  | {
      ok: false;
      kind?: "error";
      error: string;
    };

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
  } catch {
    return json<LoaderData>({
      product: null,
      error: "Failed to load product.",
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
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
      return json<ActionData>({ ok: true, kind: "suggest_keywords", keywords });
    } catch (err) {
      console.error("Keyword generation error:", err);

      return json<ActionData>(
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

  if (intent === "generate") {
    try {
      const productId = String(form.get("productId") ?? "");
      const vibe = String(form.get("vibe") ?? "casual");
      const format = String(form.get("format") ?? "paragraph");
      const keywords = String(form.get("keywords") ?? "");
      const includeSocials = form.get("includeSocials") === "true";

      const resp = await admin.graphql(
        `
          #graphql
          query ProductTitle($id: ID!) {
            product(id: $id) {
              title
              vendor
              productType
              tags
            }
          }
        `,
        { variables: { id: productId } },
      );

      const data = await resp.json();
      const p = data?.data?.product;

      if (!p) {
        return json<ActionData>(
          { ok: false, error: "Product not found" },
          { status: 404 },
        );
      }

      const result = await generateProductDescription({
        title: p.title,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        vibe,
        format,
        keywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        includeSocials,
      });

      const plainText = result.body_html.replace(/<[^>]+>/g, " ").trim();
      const wordCount = plainText ? plainText.split(/\s+/).length : 0;
      const charCount = result.body_html.replace(/<[^>]+>/g, "").length;

      return json<ActionData>({
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
      console.error("Description generation error:", err);

      return json<ActionData>(
        {
          ok: false,
          error:
            err instanceof Error ? err.message : "Description generation failed",
        },
        { status: 500 },
      );
    }
  }

  if (intent === "apply") {
    const productId = String(form.get("productId") ?? "");
    const bodyHtml = String(form.get("bodyHtml") ?? "");

    if (!productId || !bodyHtml) {
      return json<ActionData>(
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
        {
          variables: {
            id: productId,
            descriptionHtml: bodyHtml,
          },
        },
      );

      const result = await response.json();
      const userErrors = result?.data?.productUpdate?.userErrors;

      if (userErrors?.length) {
        return json<ActionData>(
          { ok: false, error: userErrors[0].message },
          { status: 400 },
        );
      }

      return json<ActionData>({ ok: true, applied: true });
    } catch (err) {
      console.error("Apply product description error:", err);

      return json<ActionData>(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to apply changes",
        },
        { status: 500 },
      );
    }
  }

  return json<ActionData>(
    { ok: false, kind: "error", error: "Invalid intent" },
    { status: 400 },
  );
}

export default function IndexPage() {
  const { product, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<ActionData>();
  const applyFetcher = useFetcher<ActionData>();

  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";

  const isSuggestingKeywords =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "suggest_keywords";

  const generationResult =
    fetcher.data?.ok && fetcher.data.kind === "generate"
      ? fetcher.data.result
      : null;

  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;
  const applyError =
    applyFetcher.data?.ok === false ? applyFetcher.data.error : null;

  const isApplying = applyFetcher.state !== "idle";

  const canApply =
    !!generationResult?.body_html && !isGenerating && !isApplying;

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

  useEffect(() => {
    if (applyFetcher.data?.ok && "applied" in applyFetcher.data && applyFetcher.data.applied) {
      setShowSuccessBanner(true);

      const timer = setTimeout(() => {
        setShowSuccessBanner(false);
      }, 4000);

      return () => clearTimeout(timer);
    }
  }, [applyFetcher.data]);

  const suggestedKeywords: string[] =
    fetcher.data?.ok && fetcher.data.kind === "suggest_keywords"
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

  const imageUrl = product?.featuredImage?.url ?? DUMMY_IMAGE;

  const keywordTags = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

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
          {actionError && (
            <Banner tone="critical" title="Something went wrong">
              <Text as="p">{actionError}</Text>
            </Banner>
          )}

          {applyError && (
            <Banner tone="critical" title="Failed to update Shopify">
              <Text as="p">{applyError}</Text>
            </Banner>
          )}

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

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 2fr",
              gap: "16px",
              alignItems: "start",
            }}
          >
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
                        <Text variant="bodySm" tone="subdued">
                          Suggested — click to add:
                        </Text>
                        <InlineStack gap="100" wrap>
                          {suggestedKeywords.map((kw) => (
                            <button
                              key={kw}
                              type="button"
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

              <Card>
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">
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
                            <Text variant="headingSm" as="h3">
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
                          <Text variant="headingMd" as="p">
                            {generationResult.wordCount}
                          </Text>
                          <Text variant="bodySm" tone="subdued" as="p">
                            Words
                          </Text>
                        </BlockStack>

                        <BlockStack gap="050">
                          <Text variant="headingMd" as="p">
                            {generationResult.charCount}
                          </Text>
                          <Text variant="bodySm" tone="subdued" as="p">
                            Characters
                          </Text>
                        </BlockStack>

                        <BlockStack gap="050">
                          <Text variant="headingMd" as="p">
                            {vibe}
                          </Text>
                          <Text variant="bodySm" tone="subdued" as="p">
                            Style
                          </Text>
                        </BlockStack>

                        <BlockStack gap="050">
                          <Text variant="headingMd" as="p">
                            {format}
                          </Text>
                          <Text variant="bodySm" tone="subdued" as="p">
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
                            onClick={() => {
                              setVibe("casual");
                              setFormat("paragraph");
                              setKeywords("");
                              setIncludeSocials(false);
                              fetcher.load(window.location.pathname);
                            }}
                          >
                            Clear
                          </Button>
                        </BlockStack>
                      </InlineStack>

                      {generationResult.primary_keyword && (
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodySm" tone="subdued" as="span">
                            Primary keyword:
                          </Text>
                          <Badge>{generationResult.primary_keyword}</Badge>
                        </InlineStack>
                      )}
                    </BlockStack>
                  ) : (
                    <Text tone="subdued" as="p">
                      Configure settings above and click "Generate Description"
                      to create an AI-powered product description.
                    </Text>
                  )}
                </BlockStack>
              </Card>

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
                      Adjust tone, keywords, and formatting.
                    </List.Item>
                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Generate Draft:
                      </Text>{" "}
                      Create an AI-powered product description.
                    </List.Item>
                    <List.Item>
                      <Text as="span" fontWeight="semibold">
                        Save to Shopify:
                      </Text>{" "}
                      Review the output and apply it directly to the product.
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}