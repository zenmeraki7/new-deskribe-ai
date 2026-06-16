import React, { memo } from "react";
import {
  BlockStack,
  Card,
  InlineStack,
  ProgressBar,
  Text,
} from "@shopify/polaris";

import { usageProgress } from "../lib/credits";
import { formatCredits } from "../utils/formatCredits";

interface CreditUsageCardProps {
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  title?: string;
  compact?: boolean;
}

export const CreditUsageCard = memo(function CreditUsageCard({
  creditsUsed,
  creditsLimit,
  creditsRemaining,
  title = "Credits",
  compact = false,
}: CreditUsageCardProps) {
  const progress = usageProgress(creditsUsed, creditsLimit);

  return (
    <Card>
      <BlockStack gap={compact ? "200" : "300"}>
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant={compact ? "headingSm" : "headingMd"}>
            {title}
          </Text>
          <Text
            as="p"
            variant={compact ? "headingMd" : "headingLg"}
            tone="success"
          >
            {formatCredits(creditsRemaining)}
          </Text>
        </InlineStack>

        <ProgressBar progress={progress} size="small" tone="primary" />

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            {formatCredits(creditsUsed)} / {formatCredits(creditsLimit)} used
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {formatCredits(creditsRemaining)} remaining
          </Text>
        </InlineStack>
      </BlockStack>
    </Card>
  );
});
