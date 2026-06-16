/**
 * Component: ProductSearchBar
 * Drop-in replacement for the existing search bar + adds Search button + Filter button
 *
 * Props:
 *  searchQuery       – controlled search string
 *  onSearchChange    – setter for searchQuery
 *  onFilterOpen      – opens the filter modal
 *  activeFilterCount – number of applied filters (shows badge on Filter button)
 */

interface ProductSearchBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onFilterOpen: () => void;
  activeFilterCount: number;
}

export function ProductSearchBar({
  searchQuery,
  onSearchChange,
  onFilterOpen,
  activeFilterCount,
}: ProductSearchBarProps) {
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      {/* ── Search Input ── */}
      <div style={{ position: "relative", flex: 1, maxWidth: "420px" }}>
        {/* Magnifier icon */}
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
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
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
          onChange={(e) => onSearchChange(e.target.value)}
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
            transition:
              "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "#005bd3";
            e.currentTarget.style.boxShadow =
              "0 0 0 2px rgba(0, 91, 211, 0.15)";
            e.currentTarget.style.background = "#fff";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "#e3e3e3";
            e.currentTarget.style.boxShadow = "none";
            e.currentTarget.style.background = "#f6f6f7";
          }}
        />

        {/* Clear "✕" button */}
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
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
              ((e.currentTarget as HTMLButtonElement).style.background =
                "#5c5f62")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.background =
                "#8c9196")
            }
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── Search Button ── */}
      <button
        onClick={() => {
          /* search is live/reactive; this can trigger a manual fetch if needed */
        }}
        style={{
          height: "36px",
          padding: "0 14px",
          borderRadius: "8px",
          border: "1px solid #e3e3e3",
          background: "#fff",
          fontSize: "13px",
          fontWeight: 500,
          color: "#1a1a1a",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          flexShrink: 0,
          transition: "background 0.15s, border-color 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "#f6f6f7";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#c9cccf";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "#fff";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#e3e3e3";
        }}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path
            d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16ZM19 19l-4.35-4.35"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Search
      </button>

      {/* ── Filter Button ── */}
      <button
        onClick={onFilterOpen}
        style={{
          height: "36px",
          padding: "0 14px",
          borderRadius: "8px",
          border: `1.5px solid ${activeFilterCount ? "#005bd3" : "#e3e3e3"}`,
          background: activeFilterCount ? "#f0f5ff" : "#fff",
          fontSize: "13px",
          fontWeight: 500,
          color: activeFilterCount ? "#005bd3" : "#1a1a1a",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          flexShrink: 0,
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!activeFilterCount) {
            (e.currentTarget as HTMLButtonElement).style.background = "#f6f6f7";
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "#c9cccf";
          }
        }}
        onMouseLeave={(e) => {
          if (!activeFilterCount) {
            (e.currentTarget as HTMLButtonElement).style.background = "#fff";
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "#e3e3e3";
          }
        }}
      >
        {/* Funnel icon */}
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 5h14M6 10h8M9 15h2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Filter
        {/* Active filter count badge */}
        {activeFilterCount > 0 && (
          <span
            style={{
              background: "#005bd3",
              color: "#fff",
              borderRadius: "20px",
              fontSize: "10px",
              fontWeight: 600,
              padding: "1px 6px",
              lineHeight: "16px",
              minWidth: "16px",
              textAlign: "center",
            }}
          >
            {activeFilterCount}
          </span>
        )}
      </button>
    </div>
  );
}