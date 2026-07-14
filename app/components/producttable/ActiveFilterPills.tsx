import { InlineStack, Tag, Button } from "@shopify/polaris";

export type FilterKey = "statuses" | "stock" | "price";

export interface FilterPill {
  label: string;
  key: FilterKey;
  value?: string;
}

interface ActiveFilterPillsProps {
  pills: FilterPill[];
  onRemove: (pill: FilterPill) => void;
  onClearAll: () => void;
}

const MAX_LABEL_LENGTH = 40;

const truncateLabel = (label: string) =>
  label.length > MAX_LABEL_LENGTH
    ? `${label.slice(0, MAX_LABEL_LENGTH)}…`
    : label;

export function ActiveFilterPills({
  pills,
  onRemove,
  onClearAll,
}: ActiveFilterPillsProps) {
  if (pills.length === 0) return null;

  return (
    <InlineStack gap="200" wrap align="start" blockAlign="center">
      {pills.map((pill) => (
        <Tag
          key={`${pill.key}-${pill.value ?? "range"}`}
          onRemove={() => onRemove(pill)}
        >
          <span title={pill.label}>{truncateLabel(pill.label)}</span>
        </Tag>
      ))}

      <Button
        variant="tertiary"
        onClick={onClearAll}
      >
        Clear all
      </Button>
    </InlineStack>
  );
}