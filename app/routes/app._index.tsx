// Enhanced Dashboard with improved design and UX
import React, { useState, useEffect } from "react";
import {
  Card,
  Page,
  Layout,
  TextField,
  IndexTable,
  Button,
  Select,
  InlineStack,
  InlineGrid,
  BlockStack,
  Text,
  Spinner,
  Checkbox,
  Toast,
  Frame,
  Badge,
  useIndexResourceState,
  EmptyState,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { Sparkles, Hash, Zap } from "lucide-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";

// ==========================
// LOADER (SERVER SIDE SEARCH)
// ==========================
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const queryString = search ? `title:*${search}*` : "";

  const response = await admin.graphql(
    `#graphql
      query GetProducts($query: String) {
        products(first: 20, query: $query) {
          nodes {
            id
            title
            description
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
      }`,
    {
      variables: {
        query: queryString,
      },
    },
  );

  const data = await response.json();
  return json({
    products: data.data?.products?.nodes ?? [],
  });
};

// ==========================
// COMPONENT
// ==========================
export default function Dashboard() {
  const { products } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const [searchTerm, setSearchTerm] = useState("");
  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [suggestedKeywords, setSuggestedKeywords] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({
    total: 0,
    completed: 0,
  });
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);

  // Properly use the useIndexResourceState hook
  const resourceIDResolver = (product: any) => product.id;

  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange: handleIndexSelectionChange,
  } = useIndexResourceState(products, {
    resourceIDResolver,
  });

  const selectedProduct =
    selectedResources.length === 1
      ? products.find((p: any) => p.id === selectedResources[0])
      : null;

  // ==========================
  // DEBOUNCED SEARCH
  // ==========================
  useEffect(() => {
    const timeout = setTimeout(() => {
      navigate(`?search=${searchTerm}`);
    }, 400);
    return () => clearTimeout(timeout);
  }, [searchTerm]);

  // ==========================
  // FETCHER RESPONSE HANDLING
  // ==========================
  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.status === "success") {
      setGeneratedContent(fetcher.data.data);
      setIsGenerating(false);
    }

    if (fetcher.data.status === "suggested") {
      setSuggestedKeywords(fetcher.data.keywords || []);
      setIsSuggesting(false);
    }

    if (fetcher.data.status === "saved") {
      setIsSaving(false);
      setToastMessage("Description saved successfully!");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2500);
    }

    if (fetcher.data.status === "bulk_complete") {
      setIsBulkGenerating(false);
      const { success, failed, total } = fetcher.data;
      setToastMessage(
        `Bulk generation complete! ✅ ${success} successful, ${failed > 0 ? `❌ ${failed} failed` : "no failures"}`
      );
      setShowToast(true);
      setTimeout(() => setShowToast(false), 4000);
      
      // Reset progress
      setBulkProgress({ total: 0, completed: 0 });
    }

    if (fetcher.data.status === "error") {
      setIsGenerating(false);
      setIsSaving(false);
      setIsSuggesting(false);
      setIsBulkGenerating(false);
      setToastMessage(fetcher.data.message || "An error occurred");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    }
  }, [fetcher.data]);

  // ==========================
  // CUSTOM SELECTION HANDLER WITH MAX LIMIT
  // ==========================
  const handleSelectionChange = (
    selectionType: any,
    isSelecting: boolean,
    selection?: string,
  ) => {
    if (selectionType === "page" && isSelecting) {
      const newSelection = products.slice(0, 10).map((p: any) => p.id);
      handleIndexSelectionChange(selectionType, isSelecting, selection);
      if (products.length > 10) {
        setToastMessage("Maximum 10 products can be selected");
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2500);
      }
      return;
    }

    if (selectionType === "single") {
      const isCurrentlySelected = selectedResources.includes(
        selection as string,
      );

      if (!isCurrentlySelected && selectedResources.length >= 10) {
        setToastMessage("Maximum 10 products allowed for selection");
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2500);
        return;
      }

      handleIndexSelectionChange(selectionType, isSelecting, selection);
    } else {
      handleIndexSelectionChange(selectionType, isSelecting, selection);
    }
  };

  // ==========================
  // ACTIONS
  // ==========================
  const handleSuggestKeywords = () => {
    if (selectedResources.length < 1 || selectedResources.length > 10) {
      setToastMessage("Please select 1-10 products");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2500);
      return;
    }

    setIsSuggesting(true);
    fetcher.submit(
      {
        actionType: "suggestKeywords",
        productId: selectedResources[0],
        vibe,
      },
      { method: "post", action: "/generate" },
    );
  };

  const handleGenerate = () => {
    if (!selectedProduct) {
      setToastMessage("Please select a single product");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2500);
      return;
    }

    setIsGenerating(true);
    setGeneratedContent(null);
    fetcher.submit(
      {
        actionType: "generate",
        productId: selectedProduct.id,
        vibe,
        format,
        keywords,
        includeSocials: String(includeSocials),
      },
      { method: "post", action: "/generate" },
    );
  };

  const handleBulkGenerate = () => {
    if (selectedResources.length < 2 || selectedResources.length > 10) {
      setToastMessage("Please select 2-10 products for bulk generation");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2500);
      return;
    }

    setIsBulkGenerating(true);
    setBulkProgress({ total: selectedResources.length, completed: 0 });

    // Send all product IDs in a single request
    fetcher.submit(
      {
        actionType: "bulkGenerate",
        productIds: JSON.stringify(selectedResources),
        vibe,
        format,
        keywords,
        includeSocials: String(includeSocials),
      },
      { method: "post", action: "/generate" }
    );
  };

  const handleSave = () => {
    if (!generatedContent || !selectedProduct) return;

    setIsSaving(true);
    fetcher.submit(
      {
        actionType: "save",
        productId: selectedProduct.id,
        descriptionHtml: generatedContent.description,
      },
      { method: "post", action: "/generate" },
    );
  };

  // ==========================
  // UI
  // ==========================
  return (
    <Frame>
      <Page title="AI Product Description Generator" fullWidth>
        <Layout>
          {/* LEFT SECTION - Product Selection */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              {/* Search Card */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd" fontWeight="semibold">
                    Search Products
                  </Text>
                  <TextField
                    label=""
                    value={searchTerm}
                    onChange={setSearchTerm}
                    placeholder="Search by product title..."
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearchTerm("")}
                  />
                </BlockStack>
              </Card>

              {/* Products Table */}
              <Card padding="0">
                {products.length === 0 ? (
                  <Box padding="400">
                    <EmptyState
                      heading="No products found"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Try adjusting your search terms</p>
                    </EmptyState>
                  </Box>
                ) : (
                  <IndexTable
                    resourceName={{ singular: "product", plural: "products" }}
                    itemCount={products.length}
                    selectedItemsCount={
                      allResourcesSelected ? "All" : selectedResources.length
                    }
                    onSelectionChange={handleSelectionChange}
                    headings={[{ title: "Product" }, { title: "Metafields" }]}
                  >
                    {products.map((p: any, index: number) => (
                      <IndexTable.Row
                        id={p.id}
                        key={p.id}
                        selected={selectedResources.includes(p.id)}
                        position={index}
                      >
                        <IndexTable.Cell>
                          <Text variant="bodyMd" fontWeight="semibold" as="span">
                            {p.title}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone="info">{p.metafields.edges.length}</Badge>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </Card>

              {/* Selection Status Card */}
              {selectedResources.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm" fontWeight="semibold">
                        Selection Summary
                      </Text>
                      {selectedResources.length === 1 && (
                        <Badge tone="success">Ready</Badge>
                      )}
                      {selectedResources.length > 1 &&
                        selectedResources.length <= 10 && (
                          <Badge tone="info">Bulk Ready</Badge>
                        )}
                      {selectedResources.length > 10 && (
                        <Badge tone="critical">Too Many</Badge>
                      )}
                    </InlineStack>

                    <Divider />

                    <BlockStack gap="200">
                      {selectedResources.length === 1 && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          1 product selected for generation
                        </Text>
                      )}
                      {selectedResources.length > 1 &&
                        selectedResources.length <= 10 && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {selectedResources.length} products selected for bulk
                            generation
                          </Text>
                        )}
                      {selectedResources.length > 10 && (
                        <Banner tone="critical">
                          Maximum 10 products allowed. Please deselect{" "}
                          {selectedResources.length - 10} product(s).
                        </Banner>
                      )}

                      {selectedProduct && (
                        <Box
                          background="bg-surface-secondary"
                          padding="300"
                          borderRadius="200"
                        >
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">
                              Current Product:
                            </Text>
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {selectedProduct.title}
                            </Text>
                          </BlockStack>
                        </Box>
                      )}
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>

          {/* RIGHT SECTION - Generation Settings & Results */}
          <Layout.Section>
            <BlockStack gap="400">
              {/* Generation Settings */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd" fontWeight="semibold">
                      Generation Settings
                    </Text>
                    <InlineStack gap="100">
                      <Sparkles size={20} style={{ color: "#5C6AC4" }} />
                    </InlineStack>
                  </InlineStack>

                  <Divider />

                  <InlineGrid columns={2} gap="400">
                    <Select
                      label="Writing Style"
                      options={[
                        { label: "✨ Casual & Friendly", value: "casual" },
                        { label: "💼 Professional", value: "professional" },
                        { label: "🔥 Edgy & Bold", value: "edgy" },
                        { label: "💎 Luxury & Premium", value: "luxury" },
                      ]}
                      value={vibe}
                      onChange={setVibe}
                    />
                    <Select
                      label="Content Format"
                      options={[
                        { label: "📝 Paragraph", value: "paragraph" },
                        { label: "• Bullet Points", value: "bullets" },
                        { label: "⚡ Short & Snappy", value: "short" },
                      ]}
                      value={format}
                      onChange={setFormat}
                    />
                  </InlineGrid>

                  <TextField
                    label="SEO Keywords"
                    value={keywords}
                    onChange={setKeywords}
                    placeholder="e.g., organic, sustainable, eco-friendly"
                    autoComplete="off"
                    multiline={2}
                    helpText="Separate keywords with commas for better SEO optimization"
                    prefix={<Hash size={16} />}
                  />

                  <Checkbox
                    label="Include social media post suggestions"
                    checked={includeSocials}
                    onChange={setIncludeSocials}
                    helpText="Generate ready-to-use Instagram and Facebook captions"
                  />

                  <Divider />

                  {/* Action Buttons */}
                  <BlockStack gap="300">
                    <InlineStack gap="200" wrap={false}>
                      <Button
                        variant="primary"
                        onClick={handleGenerate}
                        disabled={!selectedProduct || isGenerating}
                        loading={isGenerating}
                        icon={<Sparkles size={16} />}
                        size="large"
                      >
                        {isGenerating ? "Generating..." : "Generate Description"}
                      </Button>

                      <Button
                        onClick={handleSuggestKeywords}
                        disabled={selectedResources.length < 1 || isSuggesting}
                        loading={isSuggesting}
                        icon={<Hash size={16} />}
                      >
                        Suggest Keywords
                      </Button>
                    </InlineStack>

                    {selectedResources.length >= 2 &&
                      selectedResources.length <= 10 && (
                        <Button
                          variant="primary"
                          tone="success"
                          onClick={handleBulkGenerate}
                          loading={isBulkGenerating}
                          disabled={isBulkGenerating}
                          icon={<Zap size={16} />}
                          size="large"
                        >
                          Bulk Generate All ({selectedResources.length}{" "}
                          products)
                        </Button>
                      )}
                  </BlockStack>

                  {/* Bulk Progress */}
                  {isBulkGenerating && (
                    <Box
                      background="bg-surface-secondary"
                      padding="400"
                      borderRadius="200"
                    >
                      <BlockStack gap="300">
                        <InlineStack align="space-between">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            Processing {bulkProgress.total} Products...
                          </Text>
                          <Spinner size="small" />
                        </InlineStack>
                        <div
                          style={{
                            height: "8px",
                            background: "#E3E3E3",
                            borderRadius: "4px",
                            overflow: "hidden",
                            position: "relative",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              background: "linear-gradient(90deg, #008060 0%, #00B894 50%, #008060 100%)",
                              width: "40%",
                              borderRadius: "4px",
                              animation: "slide 1.5s ease-in-out infinite",
                              position: "absolute",
                            }}
                          />
                          <style>
                            {`
                              @keyframes slide {
                                0% { left: -40%; }
                                100% { left: 100%; }
                              }
                            `}
                          </style>
                        </div>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Generating AI descriptions for all selected products. This may take a minute...
                        </Text>
                      </BlockStack>
                    </Box>
                  )}
                </BlockStack>
              </Card>

              {/* Suggested Keywords Card */}
              {suggestedKeywords.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm" fontWeight="semibold">
                        AI-Suggested Keywords
                      </Text>
                      <Badge tone="success">
                        {suggestedKeywords.length} keywords
                      </Badge>
                    </InlineStack>
                    <Divider />
                    <InlineStack gap="200" wrap>
                      {suggestedKeywords.map((keyword: string, index: number) => (
                        <div
                          key={index}
                          style={{
                            padding: "8px 12px",
                            background: "#F3F4F6",
                            borderRadius: "6px",
                            cursor: "pointer",
                            transition: "all 0.2s ease",
                          }}
                          onClick={() => {
                            const currentKeywords = keywords
                              ? `${keywords}, ${keyword}`
                              : keyword;
                            setKeywords(currentKeywords);
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#E5E7EB";
                            e.currentTarget.style.transform = "translateY(-1px)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "#F3F4F6";
                            e.currentTarget.style.transform = "translateY(0)";
                          }}
                        >
                          <Text as="span" variant="bodySm" fontWeight="medium">
                            {keyword}
                          </Text>
                        </div>
                      ))}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Click any keyword to add it to your SEO keywords field
                    </Text>
                  </BlockStack>
                </Card>
              )}

              {/* Generated Content Card */}
              {generatedContent && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd" fontWeight="semibold">
                          AI Generated Description
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Review and edit before saving to your product
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        <Button
                          onClick={() =>
                            navigator.clipboard.writeText(
                              generatedContent.description,
                            )
                          }
                        >
                          Copy HTML
                        </Button>
                        <Button
                          variant="primary"
                          onClick={handleSave}
                          loading={isSaving}
                          disabled={isSaving}
                        >
                          {isSaving ? "Saving..." : "Save to Product"}
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <Divider />

                    <Box
                      background="bg-surface-secondary"
                      padding="400"
                      borderRadius="200"
                    >
                      <div
                        style={{
                          maxHeight: "500px",
                          overflowY: "auto",
                          fontSize: "14px",
                          lineHeight: "1.6",
                        }}
                        dangerouslySetInnerHTML={{
                          __html: generatedContent.description,
                        }}
                      />
                    </Box>
                  </BlockStack>
                </Card>
              )}

              {/* Empty State when nothing selected */}
              {!generatedContent &&
                !isGenerating &&
                selectedResources.length === 0 && (
                  <Card>
                    <Box padding="600">
                      <BlockStack gap="400" inlineAlign="center">
                        <div
                          style={{
                            width: "80px",
                            height: "80px",
                            background:
                              "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                            borderRadius: "50%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Sparkles size={40} color="white" />
                        </div>
                        <BlockStack gap="200" inlineAlign="center">
                          <Text
                            as="h2"
                            variant="headingLg"
                            fontWeight="semibold"
                            alignment="center"
                          >
                            Ready to Create Amazing Descriptions?
                          </Text>
                          <Text
                            as="p"
                            variant="bodyMd"
                            tone="subdued"
                            alignment="center"
                          >
                            Select a product from the list to get started with
                            AI-powered description generation
                          </Text>
                        </BlockStack>
                      </BlockStack>
                    </Box>
                  </Card>
                )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>

      {showToast && (
        <Toast content={toastMessage} onDismiss={() => setShowToast(false)} />
      )}
    </Frame>
  );
}