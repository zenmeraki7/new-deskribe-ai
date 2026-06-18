import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { BlockStack, Card, InlineStack, Layout, List, Page, Text } from "@shopify/polaris";

import { CreditUsageCard } from "../components/CreditUsageCard";
import { CREDIT_RULES, formatCredits, PLAN_LABELS } from "../lib/credits";
import { resolvePlan } from "../lib/rateLimiter.server";
import { requireAdminSession } from "../lib/auth.server";
import { db } from "../lib/db.server";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { getCreditBalance } = await import("../lib/creditService.server");
  const { billing, shopDomain } = await requireAdminSession(request);
  const { appSubscriptions } = await billing.check();
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  const balance = await getCreditBalance(shopDomain, plan);
  const creditRecord = await db.shopCredit.findUnique({
    where: { shopId: shopDomain },
    select: { cycleStartsAt: true },
  });
  const cycleStartsAt = creditRecord?.cycleStartsAt ?? new Date(0);
  const usageByAction = await db.creditUsageLog.groupBy({
    by: ["action"],
    where: {
      shop: shopDomain,
      createdAt: { gte: cycleStartsAt },
    },
    _sum: { amount: true },
    _count: { _all: true },
  });

  return json({
    balance: {
      ...balance,
      resetDate: balance.resetDate.toISOString(),
    },
    planName: appSubscriptions?.[0]?.name ?? PLAN_LABELS[plan],
    usageByAction: usageByAction
      .map((item) => ({
        action: item.action,
        credits: item._sum.amount ?? 0,
        count: item._count._all,
      }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5),
  });
};

export default function CreditsUsagePage() {
  const { balance, planName, usageByAction } = useLoaderData<typeof loader>();

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
              planName={planName}
              resetDate={balance.resetDate}
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
                  Top actions consuming credits this cycle
                </Text>
                {usageByAction.length > 0 ? (
                  <BlockStack gap="200">
                    {usageByAction.map((item) => (
                      <InlineStack key={item.action} align="space-between">
                        <Text as="p">{item.action}</Text>
                        <Text as="p" fontWeight="semibold">
                          {formatCredits(item.credits)} credits across {item.count} action
                          {item.count === 1 ? "" : "s"}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">
                    No credit-consuming actions have been logged in this cycle yet.
                  </Text>
                )}
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
