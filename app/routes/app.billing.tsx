// app/routes/app.billing.tsx
import { useLoaderData } from "@remix-run/react";
import {
  Banner,
  Layout,
  Page,
  BlockStack,
  InlineStack,
  Button,
  Text,
  Card,
  Badge,
  Grid,
  Box,
  Divider,
  Icon,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { requireAdminSession } from "../lib/auth.server";
import { checkBilling, resolvePlanHandle, type PlanHandle } from "../lib/billing.server";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

const APP_HANDLE = (process.env.SHOPIFY_APP_HANDLE || "").trim();

// NOTE: these are your REAL prices. Shopify may show $0 on dev/test stores
// while you're testing — that's expected and doesn't reflect production pricing.
const PRICING_PLANS: {
  handle: PlanHandle;
  name: string;
  price: string;
  credits: string;
  features: string[];
  recommended?: boolean;
}[] = [
  {
    handle: "free",
    name: "Free",
    price: "$0",
    credits: "100 monthly credits",
    features: [
      "Generate product descriptions",
      "AI keyword suggestions",
      "Best for trying the app",
    ],
  },
  {
    handle: "basic",
    name: "Basic",
    price: "$14.99",
    credits: "6,000 monthly credits",
    features: [
      "Bulk generation",
      "Image alt text generation",
      "Meta title & description generation",
    ],
  },
  {
    handle: "advanced",
    name: "Advanced",
    price: "$29.99",
    credits: "20,000 monthly credits",
    features: [
      "Everything in Basic",
      "Custom writing styles",
      "Save up to 10 templates",
    ],
    recommended: true,
  },
  {
    handle: "pro",
    name: "Pro",
    price: "$79.99",
    credits: "60,000 monthly credits",
    features: [
      "Everything in Advanced",
      "Highest monthly credit allowance",
      "Best for large catalogs",
    ],
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shopDomain } = await requireAdminSession(request);

  const url = new URL(request.url);
  const returnedPlanHandle = url.searchParams.get("plan_handle");
  const justReturnedFromPlanSelection = Boolean(returnedPlanHandle);

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const subscription = appSubscriptions[0] ?? null;

  // Match by numeric plan ID, not by description text.
  const activePlanHandle = resolvePlanHandle(subscription);

  const pendingConfirmation =
    justReturnedFromPlanSelection && !subscription;

  const pricingPageUrl = APP_HANDLE
    ? `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/charges/${APP_HANDLE}/pricing_plans`
    : null;

  return json({
    subscription,
    activePlanHandle,
    pendingConfirmation,
    pricingPageUrl,
    missingAppHandle: !APP_HANDLE,
    isTestCharge: subscription?.test ?? false,
  });
};

export default function Billing() {
  const {
    subscription,
    activePlanHandle,
    pendingConfirmation,
    pricingPageUrl,
    missingAppHandle,
    isTestCharge,
  } = useLoaderData<typeof loader>();

  const activePlanDisplayName = PRICING_PLANS.find(
    (p) => p.handle === activePlanHandle,
  )?.name;

  return (
    <Page title="Plan & Billing">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {pendingConfirmation ? (
              <Banner title="Confirming your plan..." tone="info">
                <Text as="p">
                  We're confirming your subscription with Shopify. Refresh this page in a
                  few seconds if this doesn't update.
                </Text>
              </Banner>
            ) : subscription && activePlanDisplayName ? (
              <Banner
                title={`Active plan: ${activePlanDisplayName}`}
                tone="success"
              >
                {isTestCharge && (
                  <Text as="p" tone="subdued">
                    This is a test charge on a development store — no real payment was made.
                  </Text>
                )}
              </Banner>
            ) : subscription && !activePlanDisplayName ? (
              // Subscription exists in Shopify but we don't recognize its plan ID yet.
              // Usually means SHOPIFY_PLAN_ID_* env vars aren't set for this plan.
              <Banner
                title={`Active subscription (unrecognized plan: ${subscription.name})`}
                tone="warning"
              >
                <Text as="p">
                  You have an active subscription, but this app doesn't recognize plan ID{" "}
                  {subscription.name}. Check that SHOPIFY_PLAN_ID_* environment variables
                  match your Partner Dashboard pricing plans.
                </Text>
              </Banner>
            ) : (
              <Banner title="You do not have an active subscription." tone="warning" />
            )}

            {missingAppHandle && (
              <Banner tone="critical" title="Missing app handle">
                Set SHOPIFY_APP_HANDLE in your .env or deployment secrets to your Partner
                Dashboard app listing slug.
              </Banner>
            )}

            <BlockStack gap="200">
              <Text as="h2" variant="headingLg">
                Choose a plan
              </Text>
              <Text as="p" tone="subdued">
                Plans and billing are managed directly through Shopify. Selecting a plan
                below will take you to Shopify's secure checkout.
              </Text>
            </BlockStack>

            <Grid>
              {PRICING_PLANS.map((plan) => {
                const isCurrent = plan.handle === activePlanHandle;

                return (
                  <Grid.Cell
                    key={plan.handle}
                    columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}
                  >
                    <Box
                      position="relative"
                      borderRadius="300"
                      borderWidth="025"
                      borderColor={
                        isCurrent
                          ? "border-success"
                          : plan.recommended
                          ? "border-emphasis"
                          : "border"
                      }
                      background="bg-surface"
                      padding="0"
                      overflowX="hidden"
                    >
                      {plan.recommended && !isCurrent && (
                        <Box
                          background="bg-fill-emphasis"
                          padding="100"
                          paddingInlineStart="300"
                          paddingInlineEnd="300"
                        >
                          <Text as="span" variant="bodySm" fontWeight="semibold" tone="text-inverse">
                            MOST POPULAR
                          </Text>
                        </Box>
                      )}

                      <Box padding="400">
                        <BlockStack gap="400">
                          <BlockStack gap="100">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingMd">
                                {plan.name}
                              </Text>
                              {isCurrent && <Badge tone="success">Current plan</Badge>}
                            </InlineStack>
                            <InlineStack gap="100" blockAlign="baseline">
                              <Text as="span" variant="heading2xl">
                                {plan.price}
                              </Text>
                              <Text as="span" tone="subdued">
                                /month
                              </Text>
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              {plan.credits}
                            </Text>
                          </BlockStack>

                          <Divider />

                          <BlockStack gap="200">
                            {plan.features.map((feature) => (
                              <InlineStack key={feature} gap="200" wrap={false} blockAlign="start">
                                <Box paddingBlockStart="050">
                                  <Icon source={CheckIcon} tone="success" />
                                </Box>
                                <Text as="span">{feature}</Text>
                              </InlineStack>
                            ))}
                          </BlockStack>

                          {pricingPageUrl ? (
                            <Button
                              variant={plan.recommended && !isCurrent ? "primary" : "secondary"}
                              url={pricingPageUrl}
                              target="_top"
                              disabled={isCurrent}
                              fullWidth
                            >
                              {isCurrent ? "Current plan" : `Choose ${plan.name}`}
                            </Button>
                          ) : (
                            <Button disabled fullWidth>
                              Unavailable
                            </Button>
                          )}
                        </BlockStack>
                      </Box>
                    </Box>
                  </Grid.Cell>
                );
              })}
            </Grid>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}