import { useState } from "react";
import { Checkbox } from "@shopify/polaris";
// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductFilters {
  statuses: string[];
  stock: string[];
  productTypes: string[];
  collections: string[];
  priceMin: string;
  priceMax: string;
}

export const EMPTY_FILTERS: ProductFilters = {
  statuses: [],
  stock: [],
  productTypes: [],
  collections: [],
  priceMin: "",
  priceMax: "",
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active", badge: { bg: "#d4f5dc", color: "#1a6632" } },
  { value: "DRAFT", label: "Draft", badge: { bg: "#f0f0f0", color: "#6d7175" } },
  { value: "ARCHIVED", label: "Archived", badge: { bg: "#fff4d4", color: "#8a5f00" } },
];

const STOCK_OPTIONS = ["In stock", "Low stock", "Out of stock"];

// ─── Sub-components ───────────────────────────────────────────────────────────

function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <Checkbox
  label={opt}
  checked={selected.includes(opt)}
  onChange={() => onToggle(opt)}
/>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
  renderLabel,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  renderLabel?: (v: string) => React.ReactNode;
}) {
  return (
    <div>
      <p style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px" }}>
        {label}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {options.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "7px 8px",
                borderRadius: "6px",
                background: checked ? "#f0f5ff" : "transparent",
                cursor: "pointer",
              }}
            >
              <Checkbox checked={checked} onChange={() => onToggle(opt)} />
              <span style={{ fontSize: "13px", flex: 1 }}>
                {renderLabel ? renderLabel(opt) : opt}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PriceInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <span
        style={{
          position: "absolute",
          left: "10px",
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: "13px",
          color: "#6d7175",
        }}
      >
        $
      </span>
      <input
        type="number"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%",
          height: "36px",
          paddingLeft: "22px",
          borderRadius: "8px",
          border: `1.5px solid ${focused ? "#005bd3" : "#e3e3e3"}`,
          background: "#f6f6f7",
          outline: "none",
        }}
      />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ProductFilterModalProps {
  open: boolean;
  onClose: () => void;
  filters: ProductFilters;
  onFiltersChange: (f: ProductFilters) => void;
  onApply: () => void;
  onClear: () => void;

  // ✅ Dynamic options from loader
  productTypeOptions: string[];
  collectionOptions: string[];
}

export function ProductFilterModal({
  open,
  onClose,
  filters,
  onFiltersChange,
  onApply,
  onClear,
  productTypeOptions,
  collectionOptions,
}: ProductFilterModalProps) {
  if (!open) return null;

  const toggle = (
    key: "statuses" | "stock" | "productTypes" | "collections",
    value: string
  ) => {
    const current = filters[key];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];

    onFiltersChange({ ...filters, [key]: next });
  };

  const handleApply = () => {
    onApply();
    onClose();
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.32)",
          zIndex: 9998,
        }}
      />

      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "360px",
          background: "#fff",
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e3e3e3" }}>
          <strong>Filters</strong>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          {/* Status */}
          <FilterGroup
            label="Status"
            options={STATUS_OPTIONS.map((s) => s.value)}
            selected={filters.statuses}
            onToggle={(v) => toggle("statuses", v)}
            renderLabel={(v) =>
              STATUS_OPTIONS.find((s) => s.value === v)?.label || v
            }
          />

          <hr style={{ margin: "20px 0" }} />

          {/* Inventory */}
          <FilterGroup
            label="Inventory"
            options={STOCK_OPTIONS}
            selected={filters.stock}
            onToggle={(v) => toggle("stock", v)}
          />

          <hr style={{ margin: "20px 0" }} />

          {/* Product Type (Dynamic) */}
          <FilterGroup
            label="Product Type"
            options={productTypeOptions}
            selected={filters.productTypes}
            onToggle={(v) => toggle("productTypes", v)}
          />

          <hr style={{ margin: "20px 0" }} />

          {/* Collections (Dynamic) */}
          <FilterGroup
            label="Collections"
            options={collectionOptions}
            selected={filters.collections}
            onToggle={(v) => toggle("collections", v)}
          />

          <hr style={{ margin: "20px 0" }} />

          {/* Price */}
          {/* <div>
            <p style={{ fontSize: "13px", fontWeight: 600 }}>
              Price range
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <PriceInput
                placeholder="Min"
                value={filters.priceMin}
                onChange={(v) =>
                  onFiltersChange({ ...filters, priceMin: v })
                }
              />
              <PriceInput
                placeholder="Max"
                value={filters.priceMax}
                onChange={(v) =>
                  onFiltersChange({ ...filters, priceMax: v })
                }
              />
            </div>
          </div> */}
        </div>

        <div
          style={{
            padding: "16px 20px",
            borderTop: "1px solid #e3e3e3",
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <button onClick={onClear}>Clear all</button>
          <button
            onClick={handleApply}
            style={{
              background: "#005bd3",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              borderRadius: "6px",
            }}
          >
            Apply filters
          </button>
        </div>
      </div>
    </>
  );
}