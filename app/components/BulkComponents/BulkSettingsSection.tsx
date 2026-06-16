import { BlockStack, Card, Divider, Select, Text } from "@shopify/polaris";
import {
  FORMAT_OPTIONS,
  VIBE_OPTIONS,
  type Format,
  type Vibe,
} from "./bulkGenerateModal.types";

export function BulkSettingsSection({
  vibe,
  format,
  isSubmitting,
  normalizedKeywords,
  onVibeChange,
  onFormatChange,
}: {
  vibe: Vibe;
  format: Format;
  isSubmitting: boolean;
  normalizedKeywords: string[];
  onVibeChange: (value: string) => void;
  onFormatChange: (value: string) => void;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Generation settings
        </Text>

        <Text as="p" variant="bodySm" tone="subdued">
          These settings apply to all selected products.
        </Text>

        <BlockStack gap="300">
          <Select
            label="Writing style"
            options={[...VIBE_OPTIONS]}
            value={vibe}
            onChange={onVibeChange}
            disabled={isSubmitting}
          />

          <Select
            label="Format"
            options={[...FORMAT_OPTIONS]}
            value={format}
            onChange={onFormatChange}
            disabled={isSubmitting}
          />
        </BlockStack>

        <Divider />

        <Text as="p" variant="bodySm" tone="subdued">
          Style: {vibe}. Format: {format}. Keywords: {normalizedKeywords.length}
          .
        </Text>
      </BlockStack>
    </Card>
  );
}
