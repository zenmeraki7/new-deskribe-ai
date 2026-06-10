import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, Text } from "@shopify/polaris";

type BillingInterval = "monthly" | "yearly";

interface PlanCardConfig {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  credits: number;
}

const plans: PlanCardConfig[] = [
  { id: "free", name: "Free", monthlyPrice: 0, yearlyPrice: 0, credits: 100 },
  { id: "basic", name: "Basic", monthlyPrice: 9.99, yearlyPrice: 83.92, credits: 6000 },
  { id: "advanced", name: "Advanced", monthlyPrice: 17.99, yearlyPrice: 151.12, credits: 20000 },
  { id: "pro", name: "Pro", monthlyPrice: 24.99, yearlyPrice: 209.92, credits: 60000 },
];

interface PricingCardsProps {
  billing: BillingInterval;
  currentPlanId?: string;
  currentBillingInterval?: BillingInterval;
  onSelectPlan?: (planId: string) => void;
}

export function PricingCards({
  billing,
  currentPlanId,
  currentBillingInterval,
  onSelectPlan,
}: PricingCardsProps) {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
      {plans.map((plan) => {
        const isActive = currentPlanId === plan.id && billing === currentBillingInterval;
        const price = billing === "monthly" ? plan.monthlyPrice : plan.yearlyPrice / 12;

        return (
          <Card key={plan.id}>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  {plan.name}
                </Text>
                {isActive && <Badge tone="success">Current</Badge>}
              </InlineStack>

              <BlockStack gap="100">
                <Text as="p" variant="headingLg">
                  {plan.monthlyPrice === 0 ? "$0" : `$${price.toFixed(2)}`}
                </Text>
                <Text as="p" tone="subdued">
                  {billing === "yearly" && plan.yearlyPrice > 0
                    ? `$${plan.yearlyPrice.toFixed(2)} billed yearly`
                    : "Monthly billing"}
                </Text>
              </BlockStack>

              <BlockStack gap="100">
                <Text as="p" variant="headingSm">
                  {plan.credits.toLocaleString()} credits/month
                </Text>
                <Text as="p" tone="subdued">
                  Credits reset every month.
                </Text>
              </BlockStack>

              <Button
                variant={isActive ? "secondary" : "primary"}
                disabled={isActive || plan.id === "free"}
                onClick={() => onSelectPlan?.(plan.id)}
              >
                {isActive ? "Current plan" : plan.id === "free" ? "Included" : "Select plan"}
              </Button>
            </BlockStack>
          </Card>
        );
      })}
    </InlineGrid>
  );
}
