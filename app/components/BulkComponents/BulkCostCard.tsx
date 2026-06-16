import {
  Banner,
  BlockStack,
  Card,
  Divider,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { formatCredits } from "../../utils/formatCredits";

function safeNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function BulkCostCard({
  creditCost,
  displayedBalance,
  monthlyCreditLimit,
  monthlyCreditsUsed,
  projectedBalance,
  projectedMonthlyCreditsUsed,
  monthlyUsagePercent,
  canGenerateWithCredits,
}: {
  creditCost: number;
  displayedBalance: number;
  monthlyCreditLimit: number;
  monthlyCreditsUsed: number;
  projectedBalance: number;
  projectedMonthlyCreditsUsed: number;
  monthlyUsagePercent: number | null;
  canGenerateWithCredits: boolean;
}) {
  const safeCreditCost = Math.max(0, safeNumber(creditCost));
  const safeDisplayedBalance = Math.max(0, safeNumber(displayedBalance));
  const safeMonthlyLimit = Math.max(0, safeNumber(monthlyCreditLimit));
  const safeMonthlyCreditsUsed = Math.max(0, safeNumber(monthlyCreditsUsed));
  const safeProjectedBalance = safeNumber(projectedBalance);
  const safeProjectedMonthlyCreditsUsed = Math.max(
    0,
    safeNumber(projectedMonthlyCreditsUsed),
  );
  const safeMonthlyUsagePercent =
    monthlyUsagePercent !== null
      ? Math.max(0, safeNumber(monthlyUsagePercent))
      : null;
  const hasMonthlyLimit = safeMonthlyLimit > 0;
  const insufficientCredits =
    safeProjectedBalance < 0 || !canGenerateWithCredits;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Credit cost
          </Text>
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {formatCredits(safeCreditCost)} credits
          </Text>
        </InlineStack>

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Current balance
          </Text>
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {formatCredits(safeDisplayedBalance)}
          </Text>
        </InlineStack>

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Balance after generation
          </Text>
          {!insufficientCredits ? (
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {formatCredits(Math.max(0, safeProjectedBalance))}
            </Text>
          ) : (
            <Text as="p" variant="bodySm" tone="critical" fontWeight="semibold">
              Insufficient credits
            </Text>
          )}
        </InlineStack>

        <Divider />

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Monthly usage
          </Text>
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {hasMonthlyLimit
              ? `${formatCredits(safeMonthlyCreditsUsed)} of ${formatCredits(
                  safeMonthlyLimit,
                )} credits`
              : "Usage unavailable"}
          </Text>
        </InlineStack>

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            After generation
          </Text>
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {hasMonthlyLimit
              ? `${formatCredits(
                  safeProjectedMonthlyCreditsUsed,
                )} of ${formatCredits(safeMonthlyLimit)} credits`
              : "Usage unavailable"}
          </Text>
        </InlineStack>

        {hasMonthlyLimit && safeMonthlyUsagePercent !== null && (
          <Text as="p" variant="bodySm" tone="subdued">
            This action will consume about {safeMonthlyUsagePercent}% of your
            monthly allowance.
          </Text>
        )}

        {insufficientCredits && (
          <Banner tone="critical" title="Not enough credits">
            This selection needs {formatCredits(safeCreditCost)} credits.
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}
