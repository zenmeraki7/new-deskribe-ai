/**
 * Component: ActiveFilterPills
 * Renders a row of removable filter tags beneath the search bar.
 *
 * Props:
 *  pills       – array of { label, key, value? } describing each active filter
 *  onRemove    – called with the pill to remove
 *  onClearAll  – clears every applied filter at once
 */

export interface FilterPill {
  label: string;
  /** "statuses" | "stock" | "price" */
  key: string;
  /** present for multi-value filters (statuses, stock); absent for price range */
  value?: string;
}

interface ActiveFilterPillsProps {
  pills: FilterPill[];
  onRemove: (pill: FilterPill) => void;
  onClearAll: () => void;
}

export function ActiveFilterPills({
  pills,
  onRemove,
  onClearAll,
}: ActiveFilterPillsProps) {
  if (pills.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        marginTop: "10px",
        alignItems: "center",
      }}
    >
      {pills.map((pill, i) => (
        <span
          key={i}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            height: "28px",
            padding: "0 10px 0 12px",
            borderRadius: "20px",
            background: "#f0f5ff",
            border: "1px solid #b8d0f5",
            fontSize: "12px",
            fontWeight: 500,
            color: "#005bd3",
          }}
        >
          {pill.label}
          <button
            onClick={() => onRemove(pill)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px",
              color: "#005bd3",
              display: "flex",
              alignItems: "center",
              fontSize: "12px",
            }}
            aria-label={`Remove ${pill.label} filter`}
          >
            ✕
          </button>
        </span>
      ))}

      <button
        onClick={onClearAll}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "12px",
          color: "#6d7175",
          padding: "2px 4px",
          textDecoration: "underline",
        }}
      >
        Clear all
      </button>
    </div>
  );
}