import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";

import { PricingCards } from "../components/PricingCards";
import { authenticate } from "../shopify.server";
import { CREDIT_COSTS, getCreditBalance, PLAN_CREDITS, PLAN_LABELS } from "../lib/creditService.server";
import { resolvePlan } from "../lib/rateLimiter.server";

const PLANS = [
  "Basic Plan",
  "Basic Plan Yearly",
  "Advanced Plan",
  "Advanced Plan Yearly",
  "Pro Plan",
  "Pro Plan Yearly",
] as const;

const PLAN_NAME_MAP: Record<string, Record<string, string>> = {
  basic: { monthly: "Basic Plan", yearly: "Basic Plan Yearly" },
  advanced: { monthly: "Advanced Plan", yearly: "Advanced Plan Yearly" },
  pro: { monthly: "Pro Plan", yearly: "Pro Plan Yearly" },
};

const isTestBilling = process.env.IS_TEST_BILLING === "true";

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  if (chargeId) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const { appSubscriptions } = await billing.check();
    const sorted = [...(appSubscriptions ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    for (const sub of sorted.slice(1)) {
      await withRetry(() => billing.cancel({ subscriptionId: sub.id }));
    }
  }

  const { appSubscriptions } = await billing.check({ plans: [...PLANS] as any, isTest: isTestBilling });
  const subscription = appSubscriptions?.[0] ?? null;
  const plan = resolvePlan(subscription?.name ?? null);
  const credits = await getCreditBalance(session.shop, plan);

  return json({
    subscription,
    plan,
    credits: {
      ...credits,
      resetDate: credits.resetDate.toISOString(),
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "cancel") {
    const { appSubscriptions } = await billing.check();
    if (appSubscriptions?.[0]) {
      await withRetry(() => billing.cancel({ subscriptionId: appSubscriptions[0].id }));
    }
    return json({ success: true, intent: "cancel" });
  }

  if (intent === "subscribe") {
    const planId = String(formData.get("planId") ?? "");
    const billingMode = String(formData.get("billingMode") ?? "");
    const planName = PLAN_NAME_MAP[planId]?.[billingMode];
    if (!planName) return json({ error: "Invalid plan" }, { status: 400 });

    await (billing as any).request({
      plan: planName,
      isTest: isTestBilling,
      returnUrl: `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing`,
    });
  }

  return json({ success: false });
};

export default function Billing() {
  const { subscription, plan, credits } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");

  const currentBillingInterval: "monthly" | "yearly" = useMemo(() => {
    const name = subscription?.name?.toLowerCase() ?? "";
    return name.includes("yearly") ? "yearly" : "monthly";
  }, [subscription?.name]);

  const usagePercent = Math.min(100, Math.max(0, (credits.creditsUsed / credits.creditsLimit) * 100));
  const resetDate = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(credits.resetDate));

  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.intent === "cancel") {
      shopify.toast.show("Plan cancelled", { duration: 5000, isError: false });
    }
  }, [actionData]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("charge_id")) {
      url.searchParams.delete("charge_id");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  function handleSelectPlan(planId: string) {
    if (planId === "free") return;
    submit({ intent: "subscribe", planId, billingMode: billing }, { method: "POST" });
  }

  return (
    <Page title="Billing">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {subscription ? (
              <Banner
                title={`Active plan: ${subscription.name}`}
                tone="success"
                secondaryAction={{
                  content: "Cancel plan",
                  onAction: () => submit({ intent: "cancel" }, { method: "POST" }),
                }}
              />
            ) : (
              <Banner title="Active plan: Free" tone="info" />
            )}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Monthly Credits
                    </Text>
                    <Text as="p" tone="subdued">
                      {PLAN_LABELS[plan]} plan renews on {resetDate}
                    </Text>
                  </BlockStack>
                  <Text as="p" variant="headingLg">
                    {credits.creditsRemaining.toLocaleString()} remaining
                  </Text>
                </InlineStack>

                <ProgressBar progress={usagePercent} tone="primary" />

                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">
                      Credits Used
                    </Text>
                    <Text as="p" variant="headingMd">
                      {credits.creditsUsed.toLocaleString()}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">
                      Credits Remaining
                    </Text>
                    <Text as="p" variant="headingMd">
                      {credits.creditsRemaining.toLocaleString()}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">
                      Credits Reset Date
                    </Text>
                    <Text as="p" variant="headingMd">
                      {resetDate}
                    </Text>
                  </BlockStack>
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Operation Costs
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                  <Text as="p">Description Generation: {CREDIT_COSTS.descriptionGeneration} credit</Text>
                  <Text as="p">SEO Optimization: {CREDIT_COSTS.seoOptimization} credits</Text>
                  <Text as="p">Keyword Suggestions: {CREDIT_COSTS.keywordSuggestion} credit</Text>
                  <Text as="p">Bulk Generation: {CREDIT_COSTS.bulkGenerationPerProduct} credit/product</Text>
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Plan Credits
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                  {Object.entries(PLAN_CREDITS).map(([key, value]) => (
                    <BlockStack key={key} gap="100">
                      <Text as="p" variant="headingSm">
                        {PLAN_LABELS[key as keyof typeof PLAN_LABELS]}
                      </Text>
                      <Text as="p">{value.toLocaleString()} credits/month</Text>
                    </BlockStack>
                  ))}
                </InlineGrid>
              </BlockStack>
            </Card>

            <InlineStack gap="200">
              <Button pressed={billing === "monthly"} onClick={() => setBilling("monthly")}>
                Pay monthly
              </Button>
              <Button pressed={billing === "yearly"} onClick={() => setBilling("yearly")}>
                Pay yearly
              </Button>
            </InlineStack>

            <Divider />

            <PricingCards
              billing={billing}
              currentPlanId={plan}
              currentBillingInterval={currentBillingInterval}
              onSelectPlan={handleSelectPlan}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
