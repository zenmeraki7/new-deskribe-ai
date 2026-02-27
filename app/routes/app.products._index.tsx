/**
 * Route: /app/products
 *
 *
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState } from "react";
import {
  Page,
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

import { ProductSearchBar } from "../components/producttable/ProductSearchbar";
import {
  ActiveFilterPills,
  type FilterPill,
} from "../components/producttable/ActiveFilterPills";
import {
  ProductFilterModal,
  type ProductFilters,
  EMPTY_FILTERS,
} from "../components/producttable/Productfiltermodal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query getProductsAndCollections {
      products(first: 100) {
        edges {
          node {
            id
            title
            status
            totalInventory
            productType
          }
        }
      }
      collections(first: 50) {
        edges {
          node {
            id
            title
          }
        }
      }
    }
  `
  );

  const data = await response.json();
  const products = data.data.products.edges.map((edge: any) => edge.node);

  const productTypes = [
    ...new Set(
      products
        .map((p: any) => p.productType)
        .filter((type: string) => type && type.trim() !== "")
    ),
  ];

  const collections = data.data.collections.edges.map(
    (edge: any) => edge.node.title
  );

  const totalProducts = products.length;
  const activeProducts = products.filter((p: any) => p.status === "ACTIVE").length;
  const draftProducts = products.filter((p: any) => p.status === "DRAFT").length;
  const totalInventory = products.reduce(
    (acc: number, p: any) => acc + (p.totalInventory || 0),
    0
  );

  const generatedDescriptions = 24;

  return {
    products,
    productTypes,
    collections,
    totalProducts,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStockCategory(qty: number): string {
  if (qty === 0) return "Out of stock";
  if (qty <= 5) return "Low stock";
  return "In stock";
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number | string;
  icon: string;
  accent: string;
  iconColor: string;
}

function StatCard({ label, value, icon, accent, iconColor }: StatCardProps) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: "140px",
        background: "#fff",
        borderRadius: "12px",
        border: "1px solid #e3e3e3",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
        cursor: "default",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 4px 16px rgba(0,0,0,0.09)";
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 1px 3px rgba(0,0,0,0.05)";
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
      }}
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
            fontSize: "11px",
            fontWeight: 600,
            color: "#6d7175",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "16px",
            width: "34px",
            height: "34px",
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
          fontSize: "30px",
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsDashboard() {
  const {
    products,
    productTypes,
    collections,
    totalProducts,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
  } = useLoaderData<typeof loader>();

  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingFilters, setPendingFilters] =
    useState<ProductFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<ProductFilters>(EMPTY_FILTERS);

  const resourceName = { singular: "product", plural: "products" };

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredProducts = products.filter((p: any) => {
    if (
      searchQuery &&
      !p.title.toLowerCase().includes(searchQuery.toLowerCase())
    )
      return false;

    if (
      appliedFilters.statuses.length > 0 &&
      !appliedFilters.statuses.includes(p.status)
    )
      return false;

    if (appliedFilters.stock.length > 0) {
      const cat = getStockCategory(p.totalInventory ?? 0);
      if (!appliedFilters.stock.includes(cat)) return false;
    }

    if (
      appliedFilters.productTypes?.length > 0 &&
      !appliedFilters.productTypes.includes(p.productType)
    )
      return false;

    return true;
  });

  // True when any search or filter is active
  const isFiltered =
    searchQuery.trim() !== "" ||
    appliedFilters.statuses.length > 0 ||
    appliedFilters.stock.length > 0 ||
    (appliedFilters.productTypes?.length || 0) > 0;

  const activeFilterCount =
    appliedFilters.statuses.length +
    appliedFilters.stock.length +
    (appliedFilters.productTypes?.length || 0);

  // ── Active filter pills ────────────────────────────────────────────────────
  const STATUS_LABEL: Record<string, string> = {
    ACTIVE: "Active",
    DRAFT: "Draft",
    ARCHIVED: "Archived",
  };

  const activeFilterPills: FilterPill[] = [
    ...appliedFilters.statuses.map((s) => ({
      label: `Status: ${STATUS_LABEL[s] ?? s}`,
      key: "statuses",
      value: s,
    })),
    ...appliedFilters.stock.map((s) => ({
      label: `Inventory: ${s}`,
      key: "stock",
      value: s,
    })),
    ...(appliedFilters.productTypes ?? []).map((t: string) => ({
      label: `Type: ${t}`,
      key: "productTypes",
      value: t,
    })),
  ];

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleRemovePill = (pill: FilterPill) => {
    if (pill.value !== undefined) {
      const next = {
        ...appliedFilters,
        [pill.key]: (
          appliedFilters[pill.key as keyof ProductFilters] as string[]
        ).filter((v) => v !== pill.value),
      };
      setAppliedFilters(next);
      setPendingFilters(next);
    }
  };

  // Resets search + all filters and restores full product list
  const handleClearAll = () => {
    setSearchQuery("");
    setAppliedFilters(EMPTY_FILTERS);
    setPendingFilters(EMPTY_FILTERS);
  };

  // ── Row markup ─────────────────────────────────────────────────────────────
  const rowMarkup = filteredProducts.map((product: any, index: number) => (
    <IndexTable.Row
      id={product.id}
      key={product.id}
      position={index}
      onClick={() => {
        const numericId = product.id.split("/").pop();
        if (numericId) navigate(`/app/products/${numericId}`);
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

  // ── Render ─────────────────────────────────────────────────────────────────
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

        {/* ── Stat Cards ────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <StatCard
            label="Total Products"
            value={totalProducts}
            icon="📦"
            accent="#eff6ff"
            iconColor="#3b82f6"
          />
          <StatCard
            label="Active"
            value={activeProducts}
            icon="✅"
            accent="#f0fdf4"
            iconColor="#22c55e"
          />
          <StatCard
            label="Draft"
            value={draftProducts}
            icon="📝"
            accent="#fefce8"
            iconColor="#eab308"
          />
          <StatCard
            label="Inventory"
            value={totalInventory.toLocaleString()}
            icon="🏪"
            accent="#fdf4ff"
            iconColor="#a855f7"
          />
          <StatCard
            label="AI Generated"
            value={generatedDescriptions}
            icon="✨"
            accent="#fff7ed"
            iconColor="#f97316"
          />
        </div>

        {/* ── Products Table ─────────────────────────────────────────────── */}
        <Card padding="0">

          {/* Table header */}
          <Box paddingInline="400" paddingBlock="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">
                All Products
              </Text>
              <InlineStack gap="300" blockAlign="center">
                <Text variant="bodySm" tone="subdued" as="span">
                  {filteredProducts.length === totalProducts
                    ? `${totalProducts} products`
                    : `${filteredProducts.length} of ${totalProducts} products`}
                </Text>
                {/*
                 * ── Clear filtered results button ──────────────────────────
                 * Visible only when a search query or filter is active.
                 * Resets search + all filters in one click.
                 */}
                {isFiltered && (
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={handleClearAll}
                  >
                    Clear results
                  </Button>
                )}
              </InlineStack>
            </InlineStack>
          </Box>

          <Divider />

          {/* Search + Filter bar */}
          <Box paddingInline="400" paddingBlock="300">
            <ProductSearchBar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onFilterOpen={() => {
                setPendingFilters({ ...appliedFilters });
                setFilterModalOpen(true);
              }}
              activeFilterCount={activeFilterCount}
            />
            <ActiveFilterPills
              pills={activeFilterPills}
              onRemove={handleRemovePill}
              onClearAll={handleClearAll}
            />
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
                <BlockStack gap="300" align="center">
                  <Text
                    variant="bodyMd"
                    tone="subdued"
                    as="p"
                    alignment="center"
                  >
                    No products match your current filters.
                  </Text>
                  <Button variant="plain" onClick={handleClearAll}>
                    Clear all filters
                  </Button>
                </BlockStack>
              </Box>
            }
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </BlockStack>

      <ProductFilterModal
        open={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        filters={pendingFilters}
        onFiltersChange={setPendingFilters}
        onApply={() => setAppliedFilters({ ...pendingFilters })}
        onClear={() => setPendingFilters(EMPTY_FILTERS)}
        productTypeOptions={productTypes}
        collectionOptions={collections}
      />
    </Page>
  );
}