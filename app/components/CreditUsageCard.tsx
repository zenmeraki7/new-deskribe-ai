import React, { memo } from "react";
import { Banner, BlockStack, Card, InlineStack, ProgressBar, Text } from "@shopify/polaris";

import { formatCredits, usageProgress } from "../lib/credits";

interface CreditUsageCardProps {
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  title?: string;
  compact?: boolean;
  planName?: string;
  resetDate?: string | Date;
}

function formatResetDate(value?: string | Date) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export const CreditUsageCard = memo(function CreditUsageCard({
  creditsUsed,
  creditsLimit,
  creditsRemaining,
  title = "Credits",
  compact = false,
  planName = "your plan",
  resetDate,
}: CreditUsageCardProps) {
  const progress = usageProgress(creditsUsed, creditsLimit);
  const resetLabel = formatResetDate(resetDate);
  const isOverLimit = creditsUsed > creditsLimit;
  const isAtLimit = creditsRemaining <= 0 || progress >= 100;
  const warningTone = isAtLimit ? "critical" : "warning";
  const progressTone = progress >= 90 ? "critical" : progress >= 80 ? "highlight" : "primary";

  const warningTitle = isOverLimit
    ? "You're over your plan limit"
    : isAtLimit
      ? "Credit limit reached"
      : progress >= 90
        ? "Credits almost used"
        : progress >= 80
          ? "Credits running low"
          : "";

  const warningMessage = isOverLimit
    ? `You're over your ${planName} limit (${formatCredits(creditsUsed)}/${formatCredits(
        creditsLimit,
      )} used). Upgrade or wait${resetLabel ? ` until ${resetLabel}` : ""} for reset.`
    : isAtLimit
      ? `You've used all credits on ${planName}. Upgrade or wait${
          resetLabel ? ` until ${resetLabel}` : ""
        } for reset.`
      : progress >= 90
        ? "You're close to your credit limit. Upgrade before bulk work is blocked."
        : progress >= 80
          ? "You've used 80% of your credits. Consider upgrading before you hit the limit."
          : "";

  return (
    <Card>
      <BlockStack gap={compact ? "200" : "300"}>
        {progress >= 80 && (
          <Banner
            tone={warningTone}
            title={warningTitle}
            action={{
              content: "Upgrade plan",
              url: "/app/billing",
              target: "_self",
            }}
          >
            {warningMessage}
          </Banner>
        )}

        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant={compact ? "headingSm" : "headingMd"}>
            {title}
          </Text>
          <Text
            as="p"
            variant={compact ? "headingMd" : "headingLg"}
            tone={isAtLimit ? "critical" : "success"}
          >
            {formatCredits(creditsRemaining)}
          </Text>
        </InlineStack>

        <ProgressBar progress={progress} size="small" tone={progressTone} />

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
