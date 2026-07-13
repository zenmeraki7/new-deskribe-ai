import { useEffect, useState } from "react";

import {
  Modal,
  ChoiceList,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Divider,
} from "@shopify/polaris";

// ─── Types ───────────────────────────────────────────────

export interface ProductFilters {
  statuses: string[];
  stock: string[];
  productTypes: string[];
  collections: string[];
}

export const EMPTY_FILTERS: ProductFilters = {
  statuses: [],
  stock: [],
  productTypes: [],
  collections: [],
};

interface ProductFilterModalProps {
  open: boolean;
  onClose: () => void;

  filters: ProductFilters;

  onApply: (filters: ProductFilters) => void;

  productTypeOptions: string[];
  collectionOptions: string[];
}


// ─── Constants ───────────────────────────────────────────

const STATUS_OPTIONS = [
  {
    label: "Active",
    value: "ACTIVE",
  },
  {
    label: "Draft",
    value: "DRAFT",
  },
  {
    label: "Archived",
    value: "ARCHIVED",
  },
];

const STOCK_OPTIONS = [
  {
    label: "In stock",
    value: "In stock",
  },
  {
    label: "Low stock",
    value: "Low stock",
  },
  {
    label: "Out of stock",
    value: "Out of stock",
  },
];


// ─── Component ───────────────────────────────────────────

export function ProductFilterModal({
  open,
  onClose,
  filters,
  onApply,
  productTypeOptions,
  collectionOptions,
}: ProductFilterModalProps) {

  const [draftFilters, setDraftFilters] =
    useState<ProductFilters>(filters);


  useEffect(() => {
    if (open) {
      setDraftFilters(filters);
    }
  }, [open, filters]);


  const updateFilter = (
    key: keyof ProductFilters,
    values: string[],
  ) => {
    setDraftFilters((current) => ({
      ...current,
      [key]: values,
    }));
  };


  const handleClear = () => {
    setDraftFilters(EMPTY_FILTERS);
  };


  const handleApply = () => {
    onApply(draftFilters);
    onClose();
  };


  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Filters"
      primaryAction={{
        content: "Apply filters",
        onAction: handleApply,
      }}
      secondaryActions={[
        {
          content: "Clear all",
          onAction: handleClear,
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="500">

          {/* Status */}
          <ChoiceList
            title="Status"
            allowMultiple
            choices={STATUS_OPTIONS}
            selected={draftFilters.statuses}
            onChange={(values) =>
              updateFilter("statuses", values)
            }
          />


          <Divider />


          {/* Inventory */}
          <ChoiceList
            title="Inventory"
            allowMultiple
            choices={STOCK_OPTIONS}
            selected={draftFilters.stock}
            onChange={(values) =>
              updateFilter("stock", values)
            }
          />


          <Divider />


          {/* Product Types */}

          {productTypeOptions.length > 0 ? (

            <ChoiceList
              title="Product Type"
              allowMultiple
              choices={
                productTypeOptions.map((type)=>({
                  label:type,
                  value:type,
                }))
              }
              selected={draftFilters.productTypes}
              onChange={(values)=>
                updateFilter(
                  "productTypes",
                  values,
                )
              }
            />

          ) : (

            <Text tone="subdued">
              No product types available
            </Text>

          )}


          <Divider />


          {/* Collections */}

          {collectionOptions.length > 0 ? (

            <ChoiceList
              title="Collections"
              allowMultiple
              choices={
                collectionOptions.map((collection)=>({
                  label:collection,
                  value:collection,
                }))
              }
              selected={draftFilters.collections}
              onChange={(values)=>
                updateFilter(
                  "collections",
                  values,
                )
              }
            />

          ) : (

            <Text tone="subdued">
              No collections available
            </Text>

          )}


        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}