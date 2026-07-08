// app/routes/app.billing.tsx
import { useLoaderData } from "@remix-run/react";
import { Banner, Layout, Page, BlockStack, Button, Text, Card } from "@shopify/polaris";
import { requireAdminSession } from "../lib/auth.server";
import { getActiveSubscription } from "../lib/partnerApi.server";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

const APP_HANDLE = (process.env.SHOPIFY_APP_HANDLE || "").trim();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shopDomain } = await requireAdminSession(request);

  // --- Detect a return from the hosted plan-selection page ---
  // Shopify appends plan_handle (and the shop domain) to your redirect URL
  // after a merchant selects/confirms a plan. No charge_id, no webhook —
  // this is the new signal. We don't trust it on its own; it just tells us
  // *when* to go confirm status with the Partner API.
  const url = new URL(request.url);
  const returnedPlanHandle = url.searchParams.get("plan_handle");
  const justReturnedFromPlanSelection = Boolean(returnedPlanHandle);

  // --- Resolve the Shop GID (Partner API needs this, not the domain) ---
  let shopGid: string | null = null;
  try {
    const shopResponse = await admin.graphql(`#graphql
      query ShopId {
        shop { id }
      }
    `);
    const shopData = await shopResponse.json();
    shopGid = shopData?.data?.shop?.id ?? null;
  } catch (error) {
    console.error("[app.billing loader] failed to resolve shop id", { error: String(error) });
  }

  const subscription = shopGid ? await getActiveSubscription(shopGid) : null;

  // If we just came back from plan selection but the Partner API still shows
  // no active subscription (or a different handle), don't assume failure —
  // Partner API can lag slightly behind the redirect. Surface it distinctly
  // so the UI can show a "confirming..." state instead of "no subscription".
  const pendingConfirmation =
    justReturnedFromPlanSelection &&
    (!subscription || !subscription.items.some((item) => item.handle === returnedPlanHandle));

  const pricingPageUrl = APP_HANDLE
    ? `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/charges/${APP_HANDLE}/pricing_plans`
    : null;

  return json({
    subscription,
    pendingConfirmation,
    pricingPageUrl,
    missingAppHandle: !APP_HANDLE,
  });
};

export default function Billing() {
  const { subscription, pendingConfirmation, pricingPageUrl, missingAppHandle } =
    useLoaderData<typeof loader>();

  return (
    <Page title="Plan & Billing">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {pendingConfirmation ? (
              <Banner title="Confirming your plan..." tone="info">
                <Text as="p">
                  We're confirming your subscription with Shopify. Refresh this page in a
                  few seconds if this doesn't update.
                </Text>
              </Banner>
            ) : subscription ? (
              <Banner
                title={`Active plan: ${subscription.items.map((i) => i.description).join(", ")}`}
                tone="success"
              />
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
                  <Button variant="primary" url={pricingPageUrl} target="_top">
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