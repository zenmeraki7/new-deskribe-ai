//app/routes/app.products._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { requireAdminSession } from "../lib/auth.server";
import { useCallback, useState } from "react";
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
  useIndexResourceState,
  Banner,
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
import { BulkGenerateModal } from "../components/BulkComponents/BulkGenerateModal";
import { BulkProgressBar } from "../components/BulkComponents/BulkProgressBar";
import { resolvePlan, type Plan } from "../lib/rateLimiter.server";
import { CreditUsageCard } from "../components/CreditUsageCard";
import { formatCredits, hasCredits } from "../lib/credits";
import { checkBilling } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { admin, shopDomain } = await requireAdminSession(request);

  let shopPlan: Plan = "free";
  try {
    const { appSubscriptions } = await checkBilling(admin.graphql);
    shopPlan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  } catch {
    // fail open â€” treat as free
  }

  const credits = await getCreditBalance(shopDomain, shopPlan);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const cursor = url.searchParams.get("cursor");

  const filters: string[] = [];

  if (search) {
    filters.push(`title:*${search}*`);
  }

  if (url.searchParams.getAll("status").length > 0) {
    const statuses = url.searchParams.getAll("status");
    filters.push(statuses.map((s) => `status:${s}`).join(" OR "));
  }

  const shopifyQuery = filters.join(" AND ");

  const response = await admin.graphql(
    `
    query getProducts($cursor: String, $query: String) {
      products(first: 20, after: $cursor, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            status
            totalInventory
            productType
            featuredImage { url altText }
            collections(first: 10) {
              edges {
                node {
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
  `,
    {
      variables: {
        cursor,
        query: shopifyQuery,
      },
    },
  );

  const data = await response.json();
  const productData = data.data.products;
  const products = productData.edges.map((edge: any) => edge.node);
  const collections = data.data.collections.edges.map(
    (edge: any) => edge.node.title,
  );

  const productTypes = Array.from(
    new Set(
      products
        .map((p: any) => p.productType)
        .filter((type: string): type is string => !!type && type.trim() !== ""),
    ),
  );

  const totalProducts = products.length;
  const activeProducts = products.filter(
    (p: any) => p.status === "ACTIVE",
  ).length;
  const draftProducts = products.filter(
    (p: any) => p.status === "DRAFT",
  ).length;
  const totalInventory = products.reduce(
    (acc: number, p: any) => acc + (p.totalInventory || 0),
    0,
  );

  const generatedDescriptions = 24;

  return {
    products,
    productTypes,
    collections,
    pageInfo: productData.pageInfo,
    totalProducts: products.length,
    activeProducts,
    draftProducts,
    totalInventory,
    generatedDescriptions,
    credits: {
      creditsUsed: credits.creditsUsed,
      creditsLimit: credits.creditsLimit,
      creditsRemaining: credits.creditsRemaining,
      resetDate: credits.resetDate.toISOString(),
    },
  };
};

// â”€â”€â”€ Helpers 

function getStockCategory(qty: number): string {
  if (qty === 0) return "Out of stock";
  if (qty <= 5) return "Low stock";
  return "In stock";
}

// â”€â”€â”€ StatCard 

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
        (e.currentTarget as HTMLDivElement).style.transform =
          "translateY(-1px)";
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

// â”€â”€â”€ Page 

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
    credits,
  } = useLoaderData<typeof loader>();

  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingFilters, setPendingFilters] =
    useState<ProductFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<ProductFilters>(EMPTY_FILTERS);

  // â”€â”€ Bulk generate state
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkSuccessBanner, setBulkSuccessBanner] = useState<{
    count: number;
  } | null>(null);
  // Track the active bulk run for the progress bar
  const [activeBulk, setActiveBulk] = useState<{
    bulkId: string;
    productCount: number;
  } | null>(null);

  const resourceName = { singular: "product", plural: "products" };

  // â”€â”€ Filtering 
  const filteredProducts = products.filter((p: any) => {
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

    if (appliedFilters.collections?.length > 0) {
      const productCollectionTitles =
        p.collections?.edges.map((e: any) => e.node.title) || [];
      const matches = appliedFilters.collections.some((selected: string) =>
        productCollectionTitles.includes(selected),
      );
      if (!matches) return false;
    }

    return true;
  });

  // â”€â”€ IndexTable selection (Polaris hook) 
  // useIndexResourceState tracks selected row IDs (the Shopify GID strings).
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
  } = useIndexResourceState(filteredProducts, {
    resourceIDResolver: (p: any) => p.id,
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

  // â”€â”€ Active filter pills 
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

  // â”€â”€ Handlers 
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

  const handleClearAll = () => {
    setSearchQuery("");
    setAppliedFilters(EMPTY_FILTERS);
    setPendingFilters(EMPTY_FILTERS);
    navigate("/app/products");
  };

  // Called by BulkGenerateModal after successful enqueue
  const handleBulkSuccess = useCallback(
    (jobIds: string[], bulkId: string | null) => {
      setBulkModalOpen(false);
      clearSelection();
      setBulkSuccessBanner({ count: jobIds.length });

      // If we have a bulkId, show the inline progress bar instead of redirecting
      if (bulkId) {
        setActiveBulk({ bulkId, productCount: jobIds.length });
      } else {
        // Single product â€” just redirect to jobs after a moment
        setTimeout(() => navigate("/app/jobs"), 2000);
      }
    },
    [clearSelection, navigate],
  );

  // â”€â”€ Promoted bulk actions (shown in IndexTable toolbar when rows selected) â”€â”€
  // â”€â”€ Bulk selection cap warning 
  const bulkCreditCost = selectedResources.length;
  const hasEnoughBulkCredits = hasCredits(credits.creditsRemaining, bulkCreditCost);

  // â”€â”€ Promoted bulk actions 
  const promotedBulkActions =
    false
      ? [
          {
            content: "Generate AI Descriptions",
            onAction: () => setBulkModalOpen(true),
            disabled: true,
          },
        ]
      : [
          {
            content: `âœ¨ Generate AI Descriptions (${selectedResources.length})`,
            onAction: () => {
              if (!hasEnoughBulkCredits) return;
              setBulkModalOpen(true);
            },
            disabled: !hasEnoughBulkCredits,
          },
        ];

  // â”€â”€ Row markup 
  // â”€â”€ Row markup â€” click row = navigate, NO modal open 
  const rowMarkup = filteredProducts.map((product: any, index: number) => {
    const numericId = product.id.split("/").pop();
    return (
      <IndexTable.Row
        id={product.id}
        key={product.id}
        position={index}
        selected={selectedResources.includes(product.id)}
        onClick={() => {
          // Row click just selects the row for bulk (Polaris default behaviour)
          // Navigation is handled by the explicit button below
        }}
      >
  <IndexTable.Cell>
  <InlineStack gap="200" blockAlign="center" wrap={false}>
    <div
      style={{
        width: "40px",
        height: "40px",
        borderRadius: "6px",
        overflow: "hidden",
        flexShrink: 0,
        background: "#f1f2f3",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <img
        src={
          product.featuredImage?.url ??
          "https://static.vecteezy.com/system/resources/previews/048/910/778/original/default-image-missing-placeholder-free-vector.jpg"
        }
        alt={product.featuredImage?.altText ?? product.title}
        style={{
          width: "100%",
          height: "100%",
          objectFit: product.featuredImage?.url ? "cover" : "contain",
          padding: product.featuredImage?.url ? "0" : "6px",
        }}
      />
    </div>
    <div
      style={{
        maxWidth: "260px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      title={product.title}
    >
      <Text variant="bodyMd" fontWeight="semibold" as="span">
        {product.title}
      </Text>
    </div>
  </InlineStack>
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
        <IndexTable.Cell>
          {/* Explicit generate button â€” the ONLY way to open the single editor */}
          <Button
            size="slim"
            variant="primary"
            disabled={selectedResources.length > 1}
            onClick={() => {
              navigate(`/app/products/${numericId}`);
            }}
            icon={<span style={{ fontSize: 12 }}>âœ¨</span>}
          >
            Generate
          </Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });
  // â”€â”€ Render
  return (
    <Page
      title="Products"
      subtitle="Manage and generate AI descriptions for your products"
      primaryAction={{
        content: "Generated Descriptions",
        onAction: () => navigate("/app/jobs"),
      }}
    >
      <BlockStack gap="600">
        {/* â”€â”€ Bulk progress bar (replaces the redirect for multi-product runs) â”€â”€ */}
        {activeBulk && (
          <BulkProgressBar
            bulkId={activeBulk.bulkId}
            productCount={activeBulk.productCount}
            onDone={() => {
              // Keep the bar visible so user can read the result; they can dismiss it
            }}
            onDismiss={() => setActiveBulk(null)}
          />
        )}

        {/* â”€â”€ Bulk success banner (single product or fallback)  */}
        {bulkSuccessBanner && !activeBulk && (
          <Banner
            tone="success"
            title={`${bulkSuccessBanner.count} job${bulkSuccessBanner.count !== 1 ? "s" : ""} queued â€” redirecting to Historyâ€¦`}
            onDismiss={() => setBulkSuccessBanner(null)}
          />
        )}

        {/* â”€â”€ Stat Cards  */}
        <CreditUsageCard
          compact
          title="Credits remaining"
          creditsUsed={credits.creditsUsed}
          creditsLimit={credits.creditsLimit}
          creditsRemaining={credits.creditsRemaining}
        />

        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <StatCard
            label="Total Products"
            value={totalProducts}
            icon="ðŸ“¦"
            accent="#eff6ff"
            iconColor="#3b82f6"
          />
          <StatCard
            label="Active"
            value={activeProducts}
            icon="âœ…"
            accent="#f0fdf4"
            iconColor="#22c55e"
          />
          <StatCard
            label="Draft"
            value={draftProducts}
            icon="ðŸ“"
            accent="#fefce8"
            iconColor="#eab308"
          />
          <StatCard
            label="Inventory"
            value={totalInventory.toLocaleString()}
            icon="ðŸª"
            accent="#fdf4ff"
            iconColor="#a855f7"
          />
          <StatCard
            label="AI Generated"
            value={generatedDescriptions}
            icon="âœ¨"
            accent="#fff7ed"
            iconColor="#f97316"
          />
        </div>

        {/* â”€â”€ Products Table  */}
        <div style={{ marginBottom: "10px" }}>
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
                onSearchChange={(value) => {
                  setSearchQuery(value);
                  if (value.trim() === "") {
                    navigate("/app/products");
                  } else {
                    navigate(
                      `/app/products?search=${encodeURIComponent(value)}`,
                    );
                  }
                }}
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

            {/* Credit availability warning */}
            {selectedResources.length > 0 && (
              <Box paddingInline="400" paddingBlockStart="200">
                {!hasEnoughBulkCredits ? (
                  <Banner
                    tone="critical"
                    title="Not enough credits"
                    action={{
                      content: "View credits",
                      url: "/app/credits",
                      target: "_self",
                    }}
                  >
                    This action costs {formatCredits(bulkCreditCost)} credits. You have{" "}
                    {formatCredits(credits.creditsRemaining)} remaining.
                  </Banner>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Credit cost before generation: {formatCredits(bulkCreditCost)}.{" "}
                    Remaining credits before action: {formatCredits(credits.creditsRemaining)}.
                  </Text>
                )}
              </Box>
            )}

            {/* â”€â”€ IndexTable â€” now selectable  */}
            <IndexTable
              resourceName={resourceName}
              itemCount={filteredProducts.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              headings={[
                { title: "Product" },
                { title: "Status" },
                { title: "Inventory", alignment: "end" },
                { title: "" }, // Generate button column â€” no heading
              ]}
              selectable={true}
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
        </div>
      </BlockStack>

      {/* â”€â”€ Filter modal  */}
      <ProductFilterModal
        open={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        filters={pendingFilters}
        onFiltersChange={setPendingFilters}
        onApply={() => setAppliedFilters({ ...pendingFilters })}
        onClear={() => setPendingFilters(EMPTY_FILTERS)}
        productTypeOptions={productTypes as string[]}
        collectionOptions={collections as string[]}
      />

      {/* â”€â”€ Bulk Generate modal */}
      <BulkGenerateModal
        open={bulkModalOpen}
        selectedProductIds={selectedResources}
        onClose={() => setBulkModalOpen(false)}
        onSuccess={handleBulkSuccess}
        creditsRemaining={credits.creditsRemaining}
      />
    </Page>
  );
}
