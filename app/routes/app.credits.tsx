import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Badge,
  Banner,
  Box,
  Card,
  Divider,
  Grid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { CreditUsageCard } from "../components/CreditUsageCard";
import { CREDIT_RULES, formatCredits, PLAN_LABELS } from "../lib/credits";
import { resolvePlan } from "../lib/rateLimiter.server";
import { requireAdminSession } from "../lib/auth.server";
import { checkBilling } from "../lib/billing.server";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { admin, shopDomain } = await requireAdminSession(request);
  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  const balance = await getCreditBalance(shopDomain, plan);

  return json({
    balance: {
      ...balance,
      resetDate: balance.resetDate.toISOString(),
    },
    planName: appSubscriptions?.[0]?.name ?? PLAN_LABELS[plan],
  });
};

export default function CreditsUsagePage() {
  const { balance, planName } = useLoaderData<typeof loader>();

  const usagePercent = balance.creditsLimit
    ? Math.min(100, Math.round((balance.creditsUsed / balance.creditsLimit) * 100))
    : 0;
  const isLow = usagePercent >= 85;

  return (
    <Page
      title="Credits / Usage"
      subtitle="Track your monthly credit consumption and plan details"
    >
      <Layout>
        {/* Main column */}
        <Layout.Section>
          <BlockStack gap="400">
            {isLow && (
              <Banner tone="warning" title="You're almost out of credits">
                <p>
                  You've used {usagePercent}% of your monthly allowance. Consider
                  upgrading your plan to avoid interruptions.
                </p>
              </Banner>
            )}

            <CreditUsageCard
              title="Monthly credits"
              creditsUsed={balance.creditsUsed}
              creditsLimit={balance.creditsLimit}
              creditsRemaining={balance.creditsRemaining}
            />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Credit rules
                </Text>
                <Text as="p" tone="subdued">
                  How different actions consume your monthly credits
                </Text>
                <Divider />
                <Grid>
                  {CREDIT_RULES.map((rule) => (
                    <Grid.Cell
                      key={rule.label}
                      columnSpan={{ xs: 6, sm: 6, md: 3, lg: 6, xl: 6 }}
                    >
                      <Box
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span">{rule.label}</Text>
                          <Badge tone="info">
                            {`${formatCredits(rule.credits)} credit${
                              rule.credits === 1 ? "" : "s"
                            }${"suffix" in rule ? ` ${rule.suffix}` : ""}`}
                          </Badge>
                        </InlineStack>
                      </Box>
                    </Grid.Cell>
                  ))}
                </Grid>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Current plan
                </Text>
                <Badge tone="success">{planName}</Badge>
              </InlineStack>

              <Divider />

              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Renews on
                  </Text>
                  <Text as="p" fontWeight="semibold">
                    {formatDate(balance.resetDate)}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Credits remaining
                  </Text>
                  <Text as="p" fontWeight="semibold">
                    {formatCredits(balance.creditsRemaining)}
                  </Text>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}