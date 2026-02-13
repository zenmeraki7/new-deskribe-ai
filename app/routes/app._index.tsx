// Converted to Shopify Polaris version
// Now includes server-side product search with debounce

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
} from "@shopify/polaris";

import { Sparkles, Hash } from "lucide-react";
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
  const { products } = useLoaderData<typeof loader>();

  const navigate = useNavigate();
  const fetcher = useFetcher();

  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [vibe, setVibe] = useState("edgy");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState(false);
  const [suggestedKeywords, setSuggestedKeywords] = useState<string[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({
    total: 0,
    completed: 0,
  });
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);
  const selectedProduct =
    selectedResources.length > 0
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
      setToast(true);
      setTimeout(() => setToast(false), 2500);
    }
    if (fetcher.data.status === "bulk_complete") {
      setIsBulkGenerating(false);

      setToast(true);
      setTimeout(() => setToast(false), 3000);

      console.log(
        `Bulk Complete: ${fetcher.data.success} success, ${fetcher.data.failed} failed`,
      );
    }

    if (fetcher.data.status === "error") {
      setIsGenerating(false);
      setIsSaving(false);
      setIsSuggesting(false);
      console.error(fetcher.data.message);
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (!products.length || selectedResources.length === 0) return;

    const stillExists = products.some(
      (p: any) => p.id === selectedResources[0],
    );

    if (!stillExists) {
      setSelectedResources([]);
    }
  }, [products]);

  // ==========================
  // ACTIONS
  // ==========================
  const handleSuggestKeywords = () => {
    if (!selectedResources.length) return;

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
      { method: "post", action: "/generate" },
    );
  };

  const handleBulkGenerate = async () => {
    if (!selectedResources.length) return;

    setIsBulkGenerating(true);
    setBulkProgress({ total: selectedResources.length, completed: 0 });

    for (let i = 0; i < selectedResources.length; i++) {
      await fetch("/generate", {
        method: "POST",
        body: new URLSearchParams({
          actionType: "bulkGenerate",
          productId: selectedResources[i],
          vibe,
          format,
          keywords,
          includeSocials: String(includeSocials),
        }),
      });

      setBulkProgress((prev) => ({
        ...prev,
        completed: prev.completed + 1,
      }));
    }

    setIsBulkGenerating(false);
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
      <Page title="Deskribe-AI" subtitle="AI-powered product copy">
        <Layout>
          {/* LEFT SECTION */}
          <Layout.Section>
            <Card title="Select a Product" sectioned>
              <TextField
                label="Search products"
                value={searchTerm}
                onChange={setSearchTerm}
                autoComplete="off"
                placeholder="Search entire store..."
              />

              <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={products.length}
                  selectedItemsCount={selectedResources.length}
                  onSelectionChange={setSelectedResources}
                  headings={[{ title: "Product" }, { title: "Metafields" }]}
                >
                  {products.map((p: any, index: number) => (
                    <IndexTable.Row id={p.id} key={p.id} position={index}>
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
                  <Text variant="headingMd">Selected Product:</Text>
                  <Text>{selectedProduct.title}</Text>
                </div>
              )}
            </Card>

<Card title="Configuration" sectioned>
  <BlockStack gap="400">
    <InlineStack gap="300">
      <Button
        primary
        loading={isGenerating}
        disabled={selectedResources.length === 0}
        onClick={handleGenerate}
      >
        Generate Description
      </Button>

      <Button
        loading={isSuggesting}
        disabled={selectedResources.length === 0}
        onClick={handleSuggestKeywords}
      >
        Suggest SEO Keywords
      </Button>

      <Button
        loading={isBulkGenerating}
        disabled={selectedResources.length === 0}
        onClick={handleBulkGenerate}
      >
        Bulk Generate ({selectedResources.length})
      </Button>
    </InlineStack>

    {isBulkGenerating && (
      <Text>
        Processing {bulkProgress.completed} / {bulkProgress.total}
      </Text>
    )}
  </BlockStack>
</Card>

{/* Suggested Keywords */}
{suggestedKeywords.length > 0 && (
  <Card title="Suggested SEO Keywords" sectioned>
    <InlineStack gap="200">
      {suggestedKeywords.map((keyword: string, index: number) => (
        <Badge key={index}>{keyword}</Badge>
      ))}
    </InlineStack>
  </Card>
)}

{/* Results */}
{generatedContent && (
  <Card title="Results" sectioned>
    <BlockStack gap="400">
      <InlineStack align="space-between">
        <Text variant="headingMd">
          AI Generated Description
        </Text>

        <Button
          onClick={() =>
            navigator.clipboard.writeText(
              generatedContent.description,
            )
          }
        >
          Copy HTML
        </Button>
      </InlineStack>

      <div
        style={{
          padding: "12px",
          border: "1px solid #e1e3e5",
          borderRadius: "8px",
        }}
        dangerouslySetInnerHTML={{
          __html: generatedContent.description,
        }}
      />

      <Button
        primary
        onClick={handleSave}
        loading={isSaving}
      >
        Save to Product
      </Button>
    </BlockStack>
  </Card>
)}

            {suggestedKeywords.length > 0 && (
  <Card title="Suggested SEO Keywords" sectioned>
    <InlineStack gap="200">
      {suggestedKeywords.map((keyword: string, index: number) => (
        <Badge key={index}>{keyword}</Badge>
      ))}
    </InlineStack>
  </Card>
)}


            {/* RESULTS */}
            {generatedContent && (
              <Card title="Results" sectioned>
                <BlockStack gap="400">
                  {/* Header with Copy Button */}
                  <InlineStack align="space-between">
                    <Text variant="headingMd">AI Generated Description</Text>

                    <Button
                      onClick={() =>
                        navigator.clipboard.writeText(
                          generatedContent.description,
                        )
                      }
                    >
                      Copy HTML
                    </Button>
                  </InlineStack>


                  {/* Rendered HTML */}
                  <div
                    style={{
                      padding: "12px",
                      border: "1px solid #e1e3e5",
                      borderRadius: "8px",
                    }}
                    dangerouslySetInnerHTML={{
                      __html: generatedContent.description,
                    }}
                  />

                  {/* Save Button */}
                  <Button primary onClick={handleSave} disabled={isSaving}>
                    {isSaving ? <Spinner size="small" /> : "Save to Product"}
                  </Button>
                </BlockStack>
              </Card>
            )}
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
