import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, ProgressBar, InlineStack, Badge, Divider, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolvePlan, PLAN_CREDITS, getShopUsageThisMonth } from "../lib/creditService.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let shopPlan = "free";
  let renewalDate: string | null = null;

  try {
    const { appSubscriptions } = await billing.check();
    const activeSub = appSubscriptions?.[0];
    shopPlan = resolvePlan(activeSub?.name ?? null);
    
    if (activeSub && activeSub.currentPeriodEnd) {
      renewalDate = new Date(activeSub.currentPeriodEnd).toLocaleDateString();
    }
  } catch {
    // Treat as free plan if billing check fails
  }

  const creditsUsed = await getShopUsageThisMonth(shopDomain);
  const totalCredits = PLAN_CREDITS[shopPlan as keyof typeof PLAN_CREDITS] || 0;

  return json({
    shopPlan,
    creditsUsed,
    totalCredits,
    renewalDate,
  });
}

export default function CreditsPage() {
  const { shopPlan, creditsUsed, totalCredits, renewalDate } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const remainingCredits = Math.max(0, totalCredits - creditsUsed);
  const progress = totalCredits > 0 ? (creditsUsed / totalCredits) * 100 : 0;
  
  // Format numbers nicely
  const displayUsed = creditsUsed % 1 === 0 ? creditsUsed : creditsUsed.toFixed(1);
  const displayRemaining = remainingCredits % 1 === 0 ? remainingCredits : remainingCredits.toFixed(1);

  return (
    <Page
      title="Credits & Usage"
      subtitle="Track your monthly API usage and manage your credits"
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Usage Card */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Monthly Usage</Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Current Plan:
                      </Text>
                      <Badge tone={shopPlan === "free" ? undefined : "info"}>
                        {`${shopPlan.charAt(0).toUpperCase()}${shopPlan.slice(1)} Plan`}
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                  <div style={{ textAlign: "right" }}>
                    <Text variant="headingLg" as="p">
                      {displayRemaining}
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="p">
                      Credits Remaining
                    </Text>
                  </div>
                </InlineStack>

                <div style={{ padding: "12px 0" }}>
                    <ProgressBar 
                      progress={progress} 
                      tone={progress >= 90 ? "critical" : progress >= 75 ? "highlight" : "success"}
                    />
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {displayUsed} used
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {totalCredits} total
                    </Text>
                  </div>
                </div>

                {renewalDate ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Your credits will reset on <strong>{renewalDate}</strong>.
                  </Text>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    You are on the Free plan. Upgrade for more credits.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {/* Credit Rules Card */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">Credit Costs</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Actions in the app consume credits from your monthly balance based on the following rules:
                </Text>
                
                <div style={{ background: "#F9FAFB", padding: "16px", borderRadius: "8px", border: "1px solid #E5E7EB" }}>
                  <List type="bullet">
                    <List.Item>
                      <strong>1 product description</strong> = 1 credit
                    </List.Item>
                    <List.Item>
                      <strong>SEO generation</strong> = 2 credits
                    </List.Item>
                    <List.Item>
                      <strong>Keyword suggestion</strong> = 0.5 credits
                    </List.Item>
                    <List.Item>
                      <strong>Bulk generation</strong> = 1 credit per product
                    </List.Item>
                  </List>
                </div>

                <InlineStack align="end">
                  <div style={{ marginTop: "8px" }}>
                    <button
                      onClick={() => navigate("/app/billing")}
                      style={{
                        padding: "8px 16px",
                        background: "#1C1C1C",
                        color: "white",
                        borderRadius: "6px",
                        border: "none",
                        fontWeight: 500,
                        cursor: "pointer"
                      }}
                    >
                      {shopPlan === "free" ? "Upgrade Plan" : "Manage Plan"}
                    </button>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
