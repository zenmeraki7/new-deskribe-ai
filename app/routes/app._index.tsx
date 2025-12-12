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
  Frame
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
  Hash
} from "lucide-react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData } from "@remix-run/react";

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
    }`
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

  const filteredProducts = PRODUCTS.filter((p, index) => {
    const match = p.title.toLowerCase().includes(searchTerm.toLowerCase());
    if (searchTerm.trim() === "") return index < 5;
    return match;
  });

  const handleGenerate = () => {
    if (!selectedProduct) return;
    setIsGenerating(true);
    setGeneratedContent(null);

    setTimeout(() => {
      const html =
        format === "bullets"
          ? `<ul>
              <li><strong>Bold:</strong> This ${selectedProduct.title} features ${keywords || "premium specs"}.</li>
              <li><strong>Design:</strong> Built for performance.</li>
            </ul>`
          : `<p>The ${selectedProduct.title} is designed with ${keywords || "high-quality materials"} for unbeatable value.</p>`;

      const socials = includeSocials
        ? {
            twitter: `Just tried ${selectedProduct.title}. Game changer. 🚀`,
            instagram: `Upgrade time.\n.\n#${vibe} #dailycarry`
          }
        : null;

      setGeneratedContent({ description: html, socials });
      setIsGenerating(false);
    }, 1500);
  };

  const handleSave = () => {
    if (!generatedContent) return;

    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setToast(true);
      setTimeout(() => setToast(false), 2500);
    }, 1200);
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
                    <IndexTable.Cell>{p.metafields.edges.length}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              {selectedProduct && (
                <div style={{ marginTop: "1rem" }}>
                  <Text as="h4" variant="headingMd">Selected Product:</Text>
                  <Text>{selectedProduct.title}</Text>
                </div>
              )}
            </Card>

            {/* CONFIGURATION */}
              <Card title="Configuration"  sectioned>
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
                      <InlineStack gap="200"><Sparkles size={14} /> Format</InlineStack>
                    </Text>
                    <Select
                      options={[
                        { label: "Paragraph", value: "paragraph" },
                        { label: "Bullet Points", value: "bullets" }
                      ]} value={format}
                      onChange={setFormat}
                    />
                  </div>

                  <div>
                    <Text as="h3" variant="headingSm">
                      <InlineStack gap="200"><Sparkles size={14} /> SEO Keywords</InlineStack>
                    </Text>
                    <TextField
                      value={keywords}
                      onChange={setKeywords}
                      placeholder="organic, waterproof"
                    />
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
                    {isGenerating ? <Spinner size="small"/> : <Sparkles size={14} />} &nbsp;
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
                      onClick={() => navigator.clipboard.writeText(generatedContent.description)}
                      icon={<Sparkles size={14} />}
                    >Copy HTML</Button>
                  </InlineStack>

                  <div
                    dangerouslySetInnerHTML={{ __html: generatedContent.description }}
                  />

                  {generatedContent.socials && (
                    <div>
                      <Text variant="headingSm">
                        <InlineStack gap="200"><Sparkles size={14} /> Social Sidecar</InlineStack>
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
                    {isSaving ? <Spinner size="small"/> : <Sparkles size={14} />}
                    &nbsp; {isSaving ? "Publishing..." : "Save to Product"}
                  </Button>
                </BlockStack>
              </Card>
            )}
          </Layout.Section>

          {/* RIGHT SIDEBAR */}
          <Layout.Section secondary>
            <Card title="How it works" sectioned>
              <p>This app analyzes product <strong>metafields</strong> & title to generate high-impact copy.</p>
              <ul>
                <li>Select a product</li>
                <li>Choose vibe</li>
                <li>Generate & publish</li>
              </ul>
            </Card>

            <Text alignment="center" variant="bodySm" tone="subdued" style={{ marginTop: "1rem" }}>
              v1.3.0-simulation
            </Text>
          </Layout.Section>

        </Layout>

        {toast && (
          <Toast content="Product updated successfully" onDismiss={() => setToast(false)} />
        )}

      </Page>
    </Frame>
  );
}
