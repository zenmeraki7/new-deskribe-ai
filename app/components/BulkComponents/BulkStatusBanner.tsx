import { Banner, BlockStack, Button, Text } from "@shopify/polaris";
import { formatCredits } from "../../utils/formatCredits";
import type { BulkResult } from "./bulkGenerateModal.types";

export function BulkStatusBanner({
  visibleResult,
  creditCost,
  creditsRemaining,
  estimatedCompletion,
  onNavigate,
}: {
  visibleResult: BulkResult | undefined;
  creditCost: number;
  creditsRemaining: number;
  estimatedCompletion: string | null;
  onNavigate: (bulkId?: string | null) => void;
}) {
  if (visibleResult?.ok) {
    const productCount = visibleResult.jobIds?.length ?? 0;

    return (
      <Banner
        tone="success"
        title={`Descriptions are being generated for ${productCount} product${
          productCount !== 1 ? "s" : ""
        }`}
      >
        <BlockStack gap="200">
          <Text as="p" variant="bodySm">
            {formatCredits(visibleResult.creditsDeducted ?? creditCost)} credits
            used. New balance:{" "}
            {formatCredits(visibleResult.newBalance ?? creditsRemaining)}{" "}
            credits.
          </Text>

          {typeof visibleResult.queuePosition === "number" && (
            <Text as="p" variant="bodySm" tone="subdued">
              Queue position: {visibleResult.queuePosition}
            </Text>
          )}

          {estimatedCompletion && (
            <Text as="p" variant="bodySm" tone="subdued">
              Estimated completion: {estimatedCompletion}
            </Text>
          )}

          {(visibleResult.skipped?.length ?? 0) > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              {visibleResult.skipped?.length} product
              {visibleResult.skipped?.length !== 1 ? "s" : ""} skipped.
            </Text>
          )}

          <Button
            variant="plain"
            onClick={() => onNavigate(visibleResult.bulkId)}
          >
            {visibleResult.bulkId ? "Review generated drafts" : "View history"}
          </Button>
        </BlockStack>
      </Banner>
    );
  }

  if (visibleResult && !visibleResult.ok) {
    const isRateLimit =
      visibleResult.code === "RATE_LIMIT_EXCEEDED" ||
      visibleResult.code === "GLOBAL_LIMIT_REACHED";

    const title =
      visibleResult.code === "INSUFFICIENT_CREDITS"
        ? "Not enough credits"
        : visibleResult.code === "ALL_SKIPPED"
          ? "No products could be queued"
          : visibleResult.code === "INVALID_INPUT" ||
              visibleResult.code === "INVALID_PRODUCT_COUNT"
            ? "Invalid product selection"
            : isRateLimit
              ? "Generation unavailable"
              : "Failed to queue jobs";

    return (
      <Banner tone={isRateLimit ? "warning" : "critical"} title={title}>
        <Text as="p" variant="bodySm">
          {visibleResult.error ??
            "An unexpected error occurred. Please try again."}
        </Text>
      </Banner>
    );
  }

  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        Review cost and settings before generating. Publishing happens later
        after merchant review.
      </Text>
      <Button variant="plain" onClick={() => onNavigate(null)}>
        Open generation history
      </Button>
    </BlockStack>
  );
}
