// app/routes/_index.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Save,
  Check,
  Copy,
  Terminal,
  Sliders,
  AlignLeft,
  List,
  Share2,
  Hash,
} from "lucide-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData } from "@remix-run/react";

// Polaris imports
import {
  Page,
  Card,
  TextField,
  Button,
  Select,
  Badge,
  Checkbox,
  Toast,
  Spinner,
  ButtonGroup,
  Modal,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Divider,
  DataTable,
  Thumbnail,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query GetProducts {
        products(first: 10) {
          nodes {
            id
            title
            description
            featuredImage {
              url
              altText
            }
            metafields(first:10){
              edges {
                node {
                  key
                  namespace
                }
              }
            }
          }
        }
      }`
  );

  const data = await response.json();
  return json({
    products: data.data?.products?.nodes ?? [],
  });
};

const LoadingSpinner = ({ size = "small" }: { size?: "small" | "large" }) => (
  <Spinner accessibilityLabel="Loading" size={size} />
);

export default function Dashboard() {
  const PRODUCTS = useLoaderData<typeof loader>().products as Array<any>;

  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchTerm), 250);
    return () => clearTimeout(id);
  }, [searchTerm]);

  const [vibe, setVibe] = useState("edgy");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const filteredProducts = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (q === "") return PRODUCTS;
    return PRODUCTS.filter((p) => p.title?.toLowerCase().includes(q));
  }, [PRODUCTS, debouncedSearch]);

  const handleProductSelect = useCallback((product: any) => {
    setSelectedProduct((prev) => {
      // Toggle selection - if same product clicked, deselect it
      if (prev?.id === product.id) {
        return null;
      }
      return product;
    });
    setGeneratedContent(null);
  }, []);

  const handleGenerate = useCallback(async () => {
    console.log("handleGenerate called for product:", selectedProduct?.id, selectedProduct?.title);
    if (!selectedProduct) return;
    setIsGenerating(true);
    setGeneratedContent(null);

    try {
      const body = new FormData();
      body.set("actionType", "generate");
      body.set("productId", selectedProduct.id);
      body.set("vibe", vibe);
      body.set("format", format);
      body.set("keywords", keywords);
      body.set("includeSocials", String(includeSocials));

      const res = await fetch("/generate", { method: "POST", body });
      const jsonResp = await res.json();

      if (res.ok && jsonResp.status === "success") {
        setGeneratedContent(jsonResp.data);
      } else {
        setToast(jsonResp.message || "Failed to generate content");
      }
    } catch (err) {
      console.error(err);
      setToast("Generation failed");
    } finally {
      setIsGenerating(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [selectedProduct, vibe, format, keywords, includeSocials]);

  const handleSave = useCallback(async () => {
    if (!generatedContent || !selectedProduct) return;
    setIsSaving(true);

    try {
      const body = new FormData();
      body.set("actionType", "save");
      body.set("productId", selectedProduct.id);
      body.set("descriptionHtml", generatedContent.description);

      const res = await fetch("/generate", { method: "POST", body });
      const jsonResp = await res.json();

      if (res.ok && jsonResp.status === "saved") {
        setToast("Product updated successfully");
      } else {
        setToast(jsonResp.message || "Failed to save");
      }
    } catch (err) {
      console.error(err);
      setToast("Save failed");
    } finally {
      setIsSaving(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [generatedContent, selectedProduct]);

  const copyHtml = useCallback(async (html: string) => {
    try {
      await navigator.clipboard.writeText(html);
      setToast("HTML copied");
      setTimeout(() => setToast(null), 1800);
    } catch {
      setToast("Unable to copy");
      setTimeout(() => setToast(null), 1800);
    }
  }, []);

  return (
    <Page
      title="Product Copy Generator"
      primaryAction={{
        content: "Docs",
        onAction: () => window.open("/docs", "_blank"),
      }}
    >
      <BlockStack gap="500">
        <InlineStack gap="400" align="start">
          {/* LEFT: MAIN CONTENT */}
          <Box width="85%">
            <BlockStack gap="400">
              {/* Products + Search */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h2">
                      Select a Product
                    </Text>
                    <Badge tone="info">
                      <InlineStack gap="100" blockAlign="center">
                        <List size={14} />
                        <Text as="span">{filteredProducts.length}</Text>
                      </InlineStack>
                    </Badge>
                  </InlineStack>

                  <TextField
                    label="Search products"
                    value={searchTerm}
                    onChange={(v) => setSearchTerm(String(v))}
                    placeholder="Search by product name..."
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearchTerm("")}
                  />

                  {filteredProducts.length === 0 ? (
                    <Box paddingBlock="400">
                      <Text variant="bodyMd" as="p" alignment="center" tone="subdued">
                        No products found
                      </Text>
                    </Box>
                  ) : (
                    <Box
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                      padding="0"
                    >
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--p-color-border)" }}>
                              <th style={{ padding: "12px", textAlign: "left", width: "60px" }}>
                                <Text variant="bodySm" as="span" fontWeight="semibold">Select</Text>
                              </th>
                              <th style={{ padding: "12px", textAlign: "left", width: "80px" }}>
                                <Text variant="bodySm" as="span" fontWeight="semibold">Image</Text>
                              </th>
                              <th style={{ padding: "12px", textAlign: "left" }}>
                                <Text variant="bodySm" as="span" fontWeight="semibold">Product Name</Text>
                              </th>
                              <th style={{ padding: "12px", textAlign: "left", minWidth: "250px" }}>
                                <Text variant="bodySm" as="span" fontWeight="semibold">Current Description</Text>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredProducts.map((item, index) => {
                              const mfCount =
                                item.metafields?.edges?.length ??
                                (Array.isArray(item.metafields)
                                  ? item.metafields.length
                                  : 0);
                              
                              const isSelected = selectedProduct?.id === item.id;
                              
                              return (
                                <tr
    key={item.id}
    onClick={() => handleProductSelect(item)}   // <- make whole row clickable
    style={{
      borderBottom: index < filteredProducts.length - 1 ? "1px solid var(--p-color-border)" : "none",
      backgroundColor: isSelected ? "var(--p-color-bg-surface-secondary)" : "transparent",
      cursor: "pointer",
    }}
  >
    <td style={{ padding: "12px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
      {/* keep checkbox but use onChange signature (checked:boolean) */}
      <Checkbox
        label=""
        labelHidden
        checked={isSelected}
        onChange={(_checked: boolean) => handleProductSelect(item)}
      />
    </td>

    <td
      style={{ padding: "12px" }}
      // clicking thumbnail will also select (tr click covers this but explicit is OK)
      onClick={(e) => { e.stopPropagation(); handleProductSelect(item); }}
    >
      <Thumbnail
        source={item.featuredImage?.url || ""}
        alt={item.featuredImage?.altText || item.title}
        size="small"
      />
    </td>

    <td style={{ padding: "12px" }}>
      <BlockStack gap="100">
        <Text variant="bodyMd" as="span" fontWeight="semibold">
          {item.title}
        </Text>
        <Badge tone="info">
          <InlineStack gap="100" blockAlign="center">
            <Hash size={10} />
            <Text as="span">{mfCount} metafields</Text>
          </InlineStack>
        </Badge>
      </BlockStack>
    </td>

    <td style={{ padding: "12px" }}>
      <Text variant="bodySm" as="span" tone="subdued">
        {item.description ? item.description.slice(0, 150) + (item.description.length > 150 ? "..." : "") : "No description found"}
      </Text>
    </td>
  </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </Box>
                  )}
                </BlockStack>
              </Card>

              {/* Selected Product Preview */}
              {selectedProduct && (
                <Card>
                  <BlockStack gap="400">
                    <Text variant="headingMd" as="h2">
                      Selected Product Preview
                    </Text>
                    
                    <InlineStack gap="400" blockAlign="start">
                      <Box>
                        <Thumbnail
                          source={selectedProduct.featuredImage?.url || ""}
                          alt={selectedProduct.featuredImage?.altText || selectedProduct.title}
                          size="large"
                        />
                      </Box>
                      
                      <BlockStack gap="300">
                        <Text variant="headingLg" as="h3" fontWeight="bold">
                          {selectedProduct.title}
                        </Text>
                        
                        <InlineStack gap="200">
                          <Badge tone="success">Selected</Badge>
                          <Badge tone="info">
                            <InlineStack gap="100" blockAlign="center">
                              <Hash size={12} />
                              <Text as="span">
                                {selectedProduct.metafields?.edges?.length ?? 0} metafields
                              </Text>
                            </InlineStack>
                          </Badge>
                        </InlineStack>

                        <Divider />

                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4" fontWeight="semibold">
                            Current Description:
                          </Text>
                          <Box
                            background="bg-surface-secondary"
                            padding="300"
                            borderRadius="200"
                          >
                            <Text variant="bodyMd" as="p" tone="subdued">
                              {selectedProduct.description || "No description available"}
                            </Text>
                          </Box>
                        </BlockStack>
                      </BlockStack>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}

              {/* Configuration + Generate */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Vibe Check
                  </Text>
                  <ButtonGroup variant="segmented">
                    {["edgy", "minimalist", "roast"].map((v) => (
                      <Button
                        key={v}
                        onClick={() => setVibe(v)}
                        pressed={vibe === v}
                      >
                        {v === "roast" ? "Real Talk" : v}
                      </Button>
                    ))}
                  </ButtonGroup>

                  <Divider />

                  <Text variant="headingMd" as="h2">
                    Format
                  </Text>
                  <Select
                    label=""
                    options={[
                      { label: "Paragraph", value: "paragraph" },
                      { label: "Bullet Points", value: "bullets" },
                      { label: "Feature List", value: "features" },
                    ]}
                    onChange={(val) => setFormat(String(val))}
                    value={format}
                  />

                  <TextField
                    label="SEO Keywords"
                    value={keywords}
                    onChange={(v) => setKeywords(String(v))}
                    placeholder="e.g., luxury, handmade, sustainable"
                    autoComplete="off"
                  />

                  <Text variant="headingMd" as="h2">
                    Options
                  </Text>
                  <Checkbox
                    label="Generate social media captions"
                    checked={includeSocials}
                    onChange={(val) => setIncludeSocials(Boolean(val))}
                  />

                  <Button
                    variant="primary"
                    onClick={handleGenerate}
                    disabled={!selectedProduct || isGenerating}
                    loading={isGenerating}
                    fullWidth
                  >
                    {isGenerating ? "Writing Copy..." : "Generate Content"}
                  </Button>
                </BlockStack>
              </Card>

              {/* Results */}
              {generatedContent && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">
                        Results
                      </Text>
                      <Badge tone="magic">
                        <InlineStack gap="100" blockAlign="center">
                          <Sparkles size={12} />
                          <Text as="span">AI Generated</Text>
                        </InlineStack>
                      </Badge>
                    </InlineStack>

                    <Box
                      background="bg-surface-secondary"
                      padding="400"
                      borderRadius="200"
                    >
                      <div
                        dangerouslySetInnerHTML={{
                          __html: generatedContent.description,
                        }}
                      />
                    </Box>

                    <InlineStack gap="200">
                      <Button
                        onClick={() => copyHtml(generatedContent.description)}
                      >
                        <InlineStack gap="100" blockAlign="center">
                          <Copy size={16} />
                          <span>Copy HTML</span>
                        </InlineStack>
                      </Button>
                      <Button onClick={() => setShowPreview(true)}>
                        <InlineStack gap="100" blockAlign="center">
                          <AlignLeft size={16} />
                          <span>Preview</span>
                        </InlineStack>
                      </Button>
                    </InlineStack>

                    {generatedContent.socials && (
                      <Box
                        background="bg-surface-secondary"
                        padding="400"
                        borderRadius="200"
                      >
                        <BlockStack gap="400">
                          <InlineStack gap="200" blockAlign="center">
                            <Share2 size={16} />
                            <Text variant="headingSm" as="h3">
                              Social Sidecar
                            </Text>
                          </InlineStack>

                          <BlockStack gap="300">
                            <Box>
                              <Text variant="headingXs" as="h4" fontWeight="semibold">
                                TWITTER / X
                              </Text>
                              <Text variant="bodyMd" as="p">
                                {generatedContent.socials.twitter}
                              </Text>
                            </Box>

                            <Box>
                              <Text variant="headingXs" as="h4" fontWeight="semibold">
                                INSTAGRAM
                              </Text>
                              <Text variant="bodyMd" as="p">
                                {generatedContent.socials.instagram}
                              </Text>
                            </Box>
                          </BlockStack>
                        </BlockStack>
                      </Box>
                    )}

                    <Button
                      variant="primary"
                      tone="success"
                      onClick={handleSave}
                      disabled={isSaving}
                      loading={isSaving}
                      fullWidth
                    >
                      {isSaving ? "Publishing..." : "Save to Product"}
                    </Button>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Box>

          {/* RIGHT: SIDEBAR */}
          <Box width="33%">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="200" blockAlign="center">
                    <Sliders size={18} />
                    <Text variant="headingMd" as="h2">
                      How it works
                    </Text>
                  </InlineStack>

                  <Text variant="bodyMd" as="p">
                    This app analyzes your product's Metafields and Title to
                    generate high-impact copy.
                  </Text>

                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Check size={16} />
                      <Text variant="bodyMd" as="p">
                        Select a product
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Check size={16} />
                      <Text variant="bodyMd" as="p">
                        Choose your Vibe
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Check size={16} />
                      <Text variant="bodyMd" as="p">
                        Generate & Publish
                      </Text>
                    </InlineStack>
                  </BlockStack>

                  <Divider />

                  <Text variant="bodySm" as="p" tone="subdued" alignment="center">
                    v1.3.0-simulation
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Box>
        </InlineStack>
      </BlockStack>

      {/* Preview Modal */}
      {showPreview && generatedContent && (
        <Modal
          open={showPreview}
          onClose={() => setShowPreview(false)}
          title="Preview HTML"
          primaryAction={{
            content: "Close",
            onAction: () => setShowPreview(false),
          }}
        >
          <Modal.Section>
            <div
              dangerouslySetInnerHTML={{
                __html: generatedContent.description,
              }}
            />
          </Modal.Section>
        </Modal>
      )}

      {/* Toast */}
      {toast && (
        <Toast
          content={toast}
          onDismiss={() => setToast(null)}
          duration={2500}
        />
      )}
    </Page>
  );
}