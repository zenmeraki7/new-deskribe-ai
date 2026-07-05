import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { BlockStack, Card, InlineStack, Layout, List, Page, Text } from "@shopify/polaris";

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

  return (
    <Page title="Credits / Usage">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <CreditUsageCard
              title="Monthly credits"
              creditsUsed={balance.creditsUsed}
              creditsLimit={balance.creditsLimit}
              creditsRemaining={balance.creditsRemaining}
            />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Plan
                </Text>
                <InlineStack align="space-between">
                  <Text as="p">Plan name</Text>
                  <Text as="p" fontWeight="semibold">
                    {planName}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p">Renewal date</Text>
                  <Text as="p" fontWeight="semibold">
                    {formatDate(balance.resetDate)}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Credit rules
                </Text>
                <List>
                  {CREDIT_RULES.map((rule) => (
                    <List.Item key={rule.label}>
                      {rule.label} = {formatCredits(rule.credits)} credit
                      {rule.credits === 1 ? "" : "s"}
                      {"suffix" in rule ? ` ${rule.suffix}` : ""}
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
