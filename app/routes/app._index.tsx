// Converted to Shopify Polaris version
// Note: Structure and logic unchanged. Components swapped to Polaris equivalents.

import React, { useState } from "react";
import {
  Card,
  Page,
  Layout,
  TextField,
  IndexTable,
  useIndexResourceState,
  Button,
  Select,
  Icon,
  InlineStack,
  InlineGrid,
  BlockStack,
  Text,
  Spinner,
  Checkbox,
  Banner,
  Toast,
  Frame,
} from "@shopify/polaris";
import {
  Sparkles,
  Save,
  Copy,
  Terminal,
  Sliders,
  AlignLeft,
  List,
  Share2,
  Check,
  Hash,
} from "lucide-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData } from "@remix-run/react";
import { useFetcher } from "@remix-run/react";
import { useEffect } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query GetProducts {
      products(first: 20) {
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
  );

  const data = await response.json();
  return json({ products: data.data?.products?.nodes ?? [] });
};

export default function Dashboard() {
  const PRODUCTS = useLoaderData<typeof loader>().products;

  const [selectedProduct, setSelectedProduct] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [vibe, setVibe] = useState("edgy");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState(false);
  const [suggestedKeywords, setSuggestedKeywords] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);

   const fetcher = useFetcher();

  const filteredProducts = PRODUCTS.filter((p, index) => {
    const match = p.title.toLowerCase().includes(searchTerm.toLowerCase());
    if (searchTerm.trim() === "") return index < 5;
    return match;
  });

  const handleSuggestKeywords = () => {
    if (!selectedProduct) return;

    setIsSuggesting(true);

    fetcher.submit(
      {
        actionType: "suggestKeywords",
        productId: selectedProduct.id,
        vibe,
      },
      { method: "post", action: "/generate" },
    );
  };

 
  const handleGenerate = () => {
    if (!selectedProduct) return;

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
      {
        method: "post",
        action: "/generate",
      },
    );
  };

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
      setToast(true);
      setTimeout(() => setToast(false), 2500);
    }

    if (fetcher.data.status === "error") {
      setIsGenerating(false);
      setIsSaving(false);
      setIsSuggesting(false);
      console.error(fetcher.data.message);
    }
  }, [fetcher.data]);

  useEffect(() => {
  setSuggestedKeywords([]);
}, [selectedProduct]);

  const handleSave = () => {
    if (!generatedContent || !selectedProduct) return;

    setIsSaving(true);

    fetcher.submit(
      {
        actionType: "save",
        productId: selectedProduct.id,
        descriptionHtml: generatedContent.description,
      },
      {
        method: "post",
        action: "/generate",
      },
    );
  };

  return (
    <Frame>
      <Page title="Deskribe-AI" subtitle="AI-powered product copy">
        <Layout>
          {/* LEFT COLUMN */}
          <Layout.Section>
            <Card title="Select a Product" sectioned>
              <TextField
                label="Search products"
                value={searchTerm}
                onChange={setSearchTerm}
                autoComplete="off"
              />

              <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={filteredProducts.length}
                  headings={[{ title: "Product" }, { title: "Metafields" }]}
                >
                  {filteredProducts.map((p, index) => (
                    <IndexTable.Row
                      id={p.id}
                      key={p.id}
                      selected={selectedProduct?.id === p.id}
                      onClick={() => setSelectedProduct(p)}
                    >
                      <IndexTable.Cell>{p.title}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {p.metafields.edges.length}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </div>

              {selectedProduct && (
                <div style={{ marginTop: "1rem" }}>
                  <Text as="h4" variant="headingMd">
                    Selected Product:
                  </Text>
                  <Text>{selectedProduct.title}</Text>
                </div>
              )}
            </Card>

            {/* CONFIGURATION */}
            <Card title="Configuration" sectioned>
              <BlockStack gap="400">
                {/* Vibe */}
                <div>
                  <Text as="h3" variant="headingSm">
                    <InlineStack gap="200">
                      <Sparkles size={14} /> Vibe Check
                    </InlineStack>
                  </Text>

                  <InlineStack gap="300">
                    {["edgy", "minimalist", "roast"].map((v) => (
                      <Button
                        key={v}
                        pressed={vibe === v}
                        onClick={() => setVibe(v)}
                      >
                        {v === "roast" ? "Real Talk" : v}
                      </Button>
                    ))}
                  </InlineStack>
                </div>

                {/* Format / keywords */}
                <InlineGrid columns={2} gap="400">
                  <div>
                    <Text as="h3" variant="headingSm">
                      <InlineStack gap="200">
                        <Sparkles size={14} /> Format
                      </InlineStack>
                    </Text>
                    <Select
                      options={[
                        { label: "Paragraph", value: "paragraph" },
                        { label: "Bullet Points", value: "bullets" },
                      ]}
                      value={format}
                      onChange={setFormat}
                    />
                  </div>

                  <div>
                    <Text as="h3" variant="headingSm">
                      <InlineStack gap="200">
                        <Hash size={14} /> SEO Keywords
                      </InlineStack>
                    </Text>

                    <InlineStack gap="200" align="space-between">
                      <TextField
                        value={keywords}
                        onChange={setKeywords}
                        placeholder="organic, waterproof"
                        autoComplete="off"
                      />

                      <Button
                        onClick={handleSuggestKeywords}
                        disabled={!selectedProduct || isSuggesting}
                      >
                        {isSuggesting ? <Spinner size="small" /> : "Suggest"}
                      </Button>
                    </InlineStack>

                    {/* Suggested keywords */}
                    {suggestedKeywords.length > 0 && (
                      <InlineStack gap="200" wrap>
                        {suggestedKeywords.map((kw) => (
                          <Button
                            key={kw}
                            size="slim"
                            onClick={() => {
                              if (!keywords.includes(kw)) {
                                setKeywords((prev) =>
                                  prev ? `${prev}, ${kw}` : kw,
                                );
                              }
                            }}
                          >
                            {kw}
                          </Button>
                        ))}
                      </InlineStack>
                    )}
                  </div>
                </InlineGrid>

                <InlineStack align="space-between">
                  <Checkbox
                    label="Generate Social Media Posts"
                    checked={includeSocials}
                    onChange={setIncludeSocials}
                  />

                  <Button
                    primary
                    onClick={handleGenerate}
                    disabled={!selectedProduct || isGenerating}
                  >
                    {isGenerating ? (
                      <Spinner size="small" />
                    ) : (
                      <Sparkles size={14} />
                    )}{" "}
                    &nbsp;
                    {isGenerating ? "Writing Copy..." : "Generate Content"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* RESULTS */}
            {generatedContent && (
              <Card title="Results" sectioned>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text variant="headingMd">AI Generated</Text>
                    <Button
                      onClick={() =>
                        navigator.clipboard.writeText(
                          generatedContent.description,
                        )
                      }
                      icon={<Sparkles size={14} />}
                    >
                      Copy HTML
                    </Button>
                  </InlineStack>

                  <div
                    dangerouslySetInnerHTML={{
                      __html: generatedContent.description,
                    }}
                  />

                  {generatedContent.socials && (
                    <div>
                      <Text variant="headingSm">
                        <InlineStack gap="200">
                          <Sparkles size={14} /> Social Sidecar
                        </InlineStack>
                      </Text>

                      <BlockStack gap="300">
                        <Card>
                          <Text>X (Twitter)</Text>
                          <Text>{generatedContent.socials.twitter}</Text>
                        </Card>

                        <Card>
                          <Text>Instagram</Text>
                          <Text>{generatedContent.socials.instagram}</Text>
                        </Card>
                      </BlockStack>
                    </div>
                  )}

                  <Button primary onClick={handleSave} disabled={isSaving}>
                    {isSaving ? (
                      <Spinner size="small" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    &nbsp; {isSaving ? "Publishing..." : "Save to Product"}
                  </Button>
                </BlockStack>
              </Card>
            )}
          </Layout.Section>

          {/* RIGHT SIDEBAR */}
          <Layout.Section secondary>
            <Card title="How it works" sectioned>
              <p>
                This app analyzes product <strong>metafields</strong> & title to
                generate high-impact copy.
              </p>
              <ul>
                <li>Select a product</li>
                <li>Choose vibe</li>
                <li>Generate & publish</li>
              </ul>
            </Card>

            <Text
              alignment="center"
              variant="bodySm"
              tone="subdued"
              style={{ marginTop: "1rem" }}
            >
              v1.3.0-simulation
            </Text>
          </Layout.Section>
        </Layout>

        {toast && (
          <Toast
            content="Product updated successfully"
            onDismiss={() => setToast(false)}
          />
        )}
      </Page>
    </Frame>
  );
}
