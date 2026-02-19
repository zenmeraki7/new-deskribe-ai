/**
 * Route: /app/products
 *
 * Products Dashboard Page
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Badge,
  Box,
  Divider,
} from "@shopify/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query getProducts {
      products(first: 50) {
        edges {
          node {
            id
            title
            status
            totalInventory
          }
        }
      }
    }
  `
  );

  const data = await response.json();
  const products = data.data.products.edges.map((edge: any) => edge.node);

  const totalProducts = products.length;
  const activeProducts = products.filter(
    (p: any) => p.status === "ACTIVE"
  ).length;
  const draftProducts = products.filter(
    (p: any) => p.status === "DRAFT"
  ).length;
  const totalInventory = products.reduce(
    (acc: number, p: any) => acc + (p.totalInventory || 0),
    0
  );

  // TODO: Replace with DB count later
  const generatedDescriptions = 24;

  return {
    products,
    totalProducts,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
  };
};

interface StatCardProps {
  label: string;
  value: number | string;
  icon: string;
  accent: string;
}

function StatCard({ label, value, icon, accent }: StatCardProps) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: "#fff",
        borderRadius: "12px",
        border: "1px solid #e3e3e3",
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        transition: "box-shadow 0.15s ease",
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 4px 14px rgba(0,0,0,0.1)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 1px 4px rgba(0,0,0,0.06)")
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: "13px",
            fontWeight: 500,
            color: "#6d7175",
            letterSpacing: "0.01em",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "20px",
            width: "36px",
            height: "36px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: accent,
            borderRadius: "8px",
          }}
        >
          {icon}
        </span>
      </div>
      <span
        style={{
          fontSize: "32px",
          fontWeight: 700,
          color: "#1a1a1a",
          lineHeight: 1,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function ProductsDashboard() {
  const {
    products,
    totalProducts,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
  } = useLoaderData<typeof loader>();

  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const resourceName = {
    singular: "product",
    plural: "products",
  };

  // TODO: Replace with your search implementation
  const filteredProducts = searchQuery
    ? products.filter((p: any) =>
        p.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : products;

  const rowMarkup = filteredProducts.map((product: any, index: number) => (
    <IndexTable.Row
      id={product.id}
      key={product.id}
      position={index}
      onClick={() => {
        const numericId = product.id.split("/").pop();
        if (numericId) {
          navigate(`/app/products/${numericId}`);
        }
      }}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="semibold" as="span">
          {product.title}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge
          tone={
            product.status === "ACTIVE"
              ? "success"
              : product.status === "DRAFT"
              ? "info"
              : "warning"
          }
        >
          {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" alignment="end" numeric>
          {product.totalInventory ?? 0}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Products"
      subtitle="Manage and generate AI descriptions for your products"
      primaryAction={{
        content: "Generate Descriptions",
        onAction: () => navigate("/app/jobs"),
      }}
    >
      <BlockStack gap="600">
        {/* Stat Cards */}
        <div
          style={{
            display: "flex",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <StatCard
            label="Total Products"
            value={totalProducts}
            icon="📦"
            accent="#f0f7ff"
          />
          <StatCard
            label="Active"
            value={activeProducts}
            icon="✅"
            accent="#f0fdf4"
          />
          <StatCard
            label="Draft"
            value={draftProducts}
            icon="📝"
            accent="#fafaf0"
          />
          <StatCard
            label="Total Inventory"
            value={totalInventory.toLocaleString()}
            icon="🏪"
            accent="#fdf4ff"
          />
          <StatCard
            label="AI Descriptions"
            value={generatedDescriptions}
            icon="✨"
            accent="#fff7f0"
          />
        </div>

        {/* Products Table */}
        <Card padding="0">
          {/* Table Header */}
          <Box paddingInline="400" paddingBlock="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">
                All Products
              </Text>
              <Text variant="bodySm" tone="subdued" as="span">
                {filteredProducts.length === totalProducts
                  ? `${totalProducts} products`
                  : `${filteredProducts.length} of ${totalProducts} products`}
              </Text>
            </InlineStack>
          </Box>
          <Divider />

          {/* Search Bar */}
          <Box paddingInline="400" paddingBlock="300">
            <div
              style={{
                position: "relative",
                maxWidth: "420px",
              }}
            >
              {/* Search Icon */}
              <div
                style={{
                  position: "absolute",
                  left: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                  color: "#8c9196",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16ZM19 19l-4.35-4.35"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>

              <input
                type="text"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  height: "36px",
                  paddingLeft: "36px",
                  paddingRight: searchQuery ? "36px" : "12px",
                  paddingTop: "0",
                  paddingBottom: "0",
                  fontSize: "14px",
                  color: "#1a1a1a",
                  background: "#f6f6f7",
                  border: "1px solid #e3e3e3",
                  borderRadius: "8px",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#005bd3";
                  e.currentTarget.style.boxShadow = "0 0 0 2px rgba(0, 91, 211, 0.15)";
                  e.currentTarget.style.background = "#fff";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "#e3e3e3";
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.background = "#f6f6f7";
                }}
              />

              {/* Clear Button */}
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  style={{
                    position: "absolute",
                    right: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "20px",
                    height: "20px",
                    borderRadius: "50%",
                    border: "none",
                    background: "#8c9196",
                    color: "#fff",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: "12px",
                    lineHeight: 1,
                    transition: "background 0.15s ease",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLButtonElement).style.background = "#5c5f62")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLButtonElement).style.background = "#8c9196")
                  }
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </Box>
          <Divider />

          <IndexTable
            resourceName={resourceName}
            itemCount={filteredProducts.length}
            headings={[
              { title: "Product" },
              { title: "Status" },
              { title: "Inventory", alignment: "end" },
            ]}
            selectable={false}
            emptyState={
              <Box padding="800">
                <BlockStack gap="200" align="center">
                  <Text variant="bodyMd" tone="subdued" as="p" alignment="center">
                    No products match &ldquo;{searchQuery}&rdquo;
                  </Text>
                  <Button variant="plain" onClick={() => setSearchQuery("")}>
                    Clear search
                  </Button>
                </BlockStack>
              </Box>
            }
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}