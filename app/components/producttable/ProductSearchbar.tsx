import {
  InlineStack,
  TextField,
  Button,
  Badge,
  Icon,
} from "@shopify/polaris";

import {
  SearchIcon,
  FilterIcon,
} from "@shopify/polaris-icons";

const MAX_QUERY_LENGTH = 200;


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

  const filterCount = Number.isFinite(activeFilterCount)
    ? Math.max(0, Math.floor(activeFilterCount))
    : 0;

  const badgeText = filterCount > 99 ? "99+" : String(filterCount);

  return (
    <InlineStack gap="200">
       <div style={{flex: 1, minWidth: 0}}>
    <TextField
      label="Search products"
      labelHidden
      type="search"
      autoComplete="off"
      value={searchQuery}
      maxLength={MAX_QUERY_LENGTH}
      prefix={<Icon source={SearchIcon} />}
      clearButton
      onClearButtonClick={() => onSearchChange("")}
      onChange={(value) =>
        onSearchChange(value.slice(0, MAX_QUERY_LENGTH))
      }
    />
  </div>

      <Button
        icon={FilterIcon}
        onClick={onFilterOpen}
        accessibilityLabel={
          filterCount
            ? `Open filters, ${filterCount} active`
            : "Open filters"
        }
      >
        Filter
      </Button>

      {filterCount > 0 && (
        <Badge tone="info">
          {badgeText}
        </Badge>
      )}
    </InlineStack>
  );
}