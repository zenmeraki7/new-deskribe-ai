import React, { memo } from "react";
import { BlockStack, Card, InlineStack, ProgressBar, Text } from "@shopify/polaris";

import { formatCredits, usageProgress } from "../lib/credits";

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

  // Design-only: map remaining share to a Polaris tone so the bar communicates
  // state (healthy / getting low / critical), not just a static percentage.
  // No business logic changes — this only affects color.
  const remainingShare = creditsLimit > 0 ? creditsRemaining / creditsLimit : 1;
  const meterTone: "primary" | "warning" | "critical" =
    remainingShare > 0.5 ? "primary" : remainingShare > 0.2 ? "warning" : "critical";

  return (
    <div className="dai-credit-card">
      <style
        dangerouslySetInnerHTML={{
          __html: `
          .dai-credit-card .Polaris-ProgressBar--sizeSmall,
          .dai-credit-card .Polaris-ProgressBar {
            border-radius: 999px;
            overflow: hidden;
          }
          .dai-credit-card [data-tone="primary"] .Polaris-ProgressBar__Indicator,
          .dai-credit-card .Polaris-ProgressBar--tonePrimary .Polaris-ProgressBar__Indicator {
            background: linear-gradient(90deg, #6D5BFF 0%, #00C2A8 100%) !important;
          }
        `,
        }}
      />
      <Card>
        <BlockStack gap={compact ? "200" : "300"}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant={compact ? "headingSm" : "headingMd"}>
              {title}
            </Text>
            <Text as="p" variant={compact ? "headingMd" : "headingLg"} tone="success">
              <span className="dai-mono">{formatCredits(creditsRemaining)}</span>
            </Text>
          </InlineStack>

          <div data-tone={meterTone}>
            <ProgressBar progress={progress} size="small" tone={meterTone} />
          </div>

          <InlineStack align="space-between">
            <Text as="p" variant="bodySm" tone="subdued">
              <span className="dai-mono">{formatCredits(creditsUsed)}</span> /{" "}
              <span className="dai-mono">{formatCredits(creditsLimit)}</span> used
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              <span className="dai-mono">{formatCredits(creditsRemaining)}</span> remaining
            </Text>
          </InlineStack>
        </BlockStack>
      </Card>
    </div>
  );
});