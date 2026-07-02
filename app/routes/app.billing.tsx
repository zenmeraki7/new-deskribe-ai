// app/routes/app.billing.tsx
import { useLoaderData } from "@remix-run/react";
import { Banner, Layout, Page, BlockStack, Button, Text, Card } from "@shopify/polaris";
import { requireAdminSession } from "../lib/auth.server";
import { checkBilling } from "../lib/billing.server";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

// TODO: replace with your app's actual handle from Partner Dashboard
// (Partner Dashboard Ã¢â€ â€™ your app Ã¢â€ â€™ the URL slug in the app listing page,
// NOT the client_id). Something like "des-kribe-ai" or similar.
const APP_HANDLE = (process.env.SHOPIFY_APP_HANDLE || "").trim();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shopDomain } = await requireAdminSession(request);

  const { appSubscriptions } = await checkBilling(admin.graphql);

  const pricingPageUrl = APP_HANDLE
    ? `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/charges/${APP_HANDLE}/pricing_plans`
    : null;

  return json({
    subscription: appSubscriptions?.[0] ?? null,
    pricingPageUrl,
    missingAppHandle: !APP_HANDLE,
  });
};

// No action needed Ã¢â‚¬â€ subscribe/cancel happen entirely on Shopify's
// hosted pricing page under Managed Pricing.

export default function Billing() {
  const { subscription, pricingPageUrl, missingAppHandle } = useLoaderData<typeof loader>();

  return (
    <Page title="Plan & Billing">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {subscription ? (
              <Banner title={`Active subscription: ${subscription.name}`} tone="success" />
            ) : (
              <Banner title="You do not have an active subscription." tone="warning" />
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="p">
                  Plans and billing are managed directly through Shopify.
                  Click below to view or change your plan.
                </Text>
                {pricingPageUrl ? (
                  <Button
                    variant="primary"
                    url={pricingPageUrl}
                    target="_top"
                  >
                    Manage plan on Shopify
                  </Button>
                ) : missingAppHandle ? (
                  <Banner tone="critical" title="Missing app handle">
                    Set SHOPIFY_APP_HANDLE in your .env or deployment secrets to your Partner Dashboard app listing slug.
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}