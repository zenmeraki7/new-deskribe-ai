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

  // ✅ FIXED: Proper combined GraphQL query
const response = await admin.graphql(`
  query getProductsAndCollections {
    products(first: 100) {
      edges {
        node {
          id
          title
          status
          totalInventory
          productType
          collections(first: 20) {
            edges {
              node {
                id
                title
              }
            }
          }
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
`);

  const data = await response.json();

const products = data.data.products.edges.map((edge: any) => {
  const node = edge.node;

  return {
    ...node,
    collections: node.collections.edges.map((c: any) => c.node.title),
  };
});

  // ✅ Extract unique product types
  const productTypes = [
    ...new Set(
      products
        .map((p: any) => p.productType)
        .filter((type: string) => type && type.trim() !== "")
    ),
  ];

  // ✅ Extract collection titles
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
    productTypes,      // ✅ NEW
    collections,       // ✅ NEW
    totalProducts,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
  };
};

// ─────────────────────────────────────────────────────────────────────────────

function getStockCategory(qty: number): string {
  if (qty === 0) return "Out of stock";
  if (qty <= 5) return "Low stock";
  return "In stock";
}

export default function ProductsDashboard() {
  const {
    products,
    productTypes,   // ✅ NEW
    collections,    // ✅ NEW
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

  // ✅ UPDATED filtering logic
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
if (
  appliedFilters.collections?.length > 0 &&
  !appliedFilters.collections.some((col) =>
    p.collections?.includes(col)
  )
)
  return false;
    return true;
  });

  const activeFilterCount =
  appliedFilters.statuses.length +
  appliedFilters.stock.length +
  (appliedFilters.productTypes?.length || 0) +
  (appliedFilters.collections?.length || 0);

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
          {product.status.charAt(0) +
            product.status.slice(1).toLowerCase()}
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

{/* Compact Stats Cards */}
<div
  style={{
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  }}
>
  {[
    { label: "Total", value: totalProducts },
    { label: "Active", value: activeProducts },
    { label: "Draft", value: draftProducts },
    { label: "Inventory", value: totalInventory },
    { label: "AI Generated", value: generatedDescriptions },
  ].map((stat) => (
    <Card key={stat.label} padding="300">
      <div
        style={{
          minWidth: "140px",
          textAlign: "center",
        }}
      >
        <Text variant="headingLg" as="p">
          {stat.value}
        </Text>
        <Text variant="bodySm" tone="subdued" as="p">
          {stat.label}
        </Text>
      </div>
    </Card>
  ))}
</div>
        {/* Table */}
        <Card padding="0">
          <Box padding="400">
           <InlineStack align="space-between">
  <ProductSearchBar
    searchQuery={searchQuery}
    onSearchChange={setSearchQuery}
    onFilterOpen={() => {
      setPendingFilters({ ...appliedFilters });
      setFilterModalOpen(true);
    }}
    activeFilterCount={activeFilterCount}
  />

  {(searchQuery || activeFilterCount > 0) && (
    <Button
      tone="critical"
      variant="secondary"
      onClick={() => {
        setSearchQuery("");
        setAppliedFilters(EMPTY_FILTERS);
      }}
    >
      Clear Filters
    </Button>
  )}
</InlineStack>
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
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </BlockStack>

      {/* ✅ UPDATED Modal with dynamic options */}
      <ProductFilterModal
        open={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        filters={pendingFilters}
        onFiltersChange={setPendingFilters}
        onApply={() => setAppliedFilters({ ...pendingFilters })}
        onClear={() => setPendingFilters(EMPTY_FILTERS)}
        productTypeOptions={productTypes}     // ✅ dynamic
        collectionOptions={collections}      // ✅ dynamic
      />
    </Page>
  );
}