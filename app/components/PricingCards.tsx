import React, { memo } from "react";
import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, Text } from "@shopify/polaris";

import { formatCredits, PLAN_CREDITS } from "../lib/credits";

interface Plan {
  id: "free" | "basic" | "standard" | "pro";
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  highlighted?: boolean;
  badge?: string;
}

const plans: Plan[] = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    yearlyPrice: 0,
  },
  {
    id: "basic",
    name: "Basic Plan",
    monthlyPrice: 9.99,
    yearlyPrice: 83.92,
  },
  {
    id: "standard",
    name: "Standard Plan",
    monthlyPrice: 17.99,
    yearlyPrice: 151.12,
    highlighted: true,
    badge: "Most Popular",
  },
  {
    id: "pro",
    name: "Pro Plan",
    monthlyPrice: 24.99,
    yearlyPrice: 209.92,
  },
];

interface PricingCardsProps {
  billing: "monthly" | "yearly";
  currentPlanId?: string;
  currentBillingInterval?: "monthly" | "yearly";
  onSelectPlan?: (planId: string) => void;
}

export const PricingCards = memo(function PricingCards({
  billing,
  currentPlanId,
  currentBillingInterval,
  onSelectPlan,
}: PricingCardsProps) {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          billing={billing}
          isActive={currentPlanId === plan.id && billing === currentBillingInterval}
          onSelect={onSelectPlan}
        />
      ))}
    </InlineGrid>
  );
});

const PlanCard = memo(function PlanCard({
  plan,
  billing,
  isActive,
  onSelect,
}: {
  plan: Plan;
  billing: "monthly" | "yearly";
  isActive?: boolean;
  onSelect?: (planId: string) => void;
}) {
  const isFree = plan.monthlyPrice === 0;
  const monthlyDisplayPrice = billing === "monthly" ? plan.monthlyPrice : plan.yearlyPrice / 12;

  return (
    <Card background={plan.highlighted ? "bg-surface-secondary" : "bg-surface"}>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            {plan.name}
          </Text>
          <InlineStack gap="100">
            {plan.badge ? <Badge tone="info">{plan.badge}</Badge> : null}
            {isActive ? <Badge tone="success">Current</Badge> : null}
          </InlineStack>
        </InlineStack>

        <BlockStack gap="100">
          <Text as="p" variant="headingLg">
            {isFree ? "Free" : `$${monthlyDisplayPrice.toFixed(2)}`}
          </Text>
          {!isFree ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {billing === "yearly"
                ? `$${plan.yearlyPrice.toFixed(2)} billed yearly`
                : "Billed monthly"}
            </Text>
          ) : null}
        </BlockStack>

        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Monthly credits
          </Text>
          <Text as="p" variant="headingMd">
            {formatCredits(PLAN_CREDITS[plan.id])}
          </Text>
        </BlockStack>

        <Button
          fullWidth
          variant={plan.highlighted ? "primary" : "secondary"}
          disabled={isActive || isFree}
          onClick={() => onSelect?.(plan.id)}
        >
          {isActive ? "Current Plan" : isFree ? "Included" : "Select Plan"}
        </Button>
      </BlockStack>
    </Card>
  );
});
