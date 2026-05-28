import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { Banner, Layout, Page, BlockStack } from "@shopify/polaris";
import { authenticate } from "app/shopify.server";
import { json, LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useEffect, useState } from "react";
import { PricingCards } from "../components/PricingCards";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const { appSubscriptions } = await billing.check();
  return json({ subscription: appSubscriptions?.[0] ?? null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const { appSubscriptions } = await billing.check();
  if (appSubscriptions?.[0]) {
    await billing.cancel({ subscriptionId: appSubscriptions[0].id });
  }
  return json({ success: true });
};

export default function Billing() {
  const { subscription } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show("Plan Successfully Cancelled", {
        duration: 5000,
        isError: false,
      });
    }
  }, [actionData]);

  return (
    <Page title="Select a Plan">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {subscription ? (
              <Banner
                title={`Active subscription: ${subscription.name}`}
                tone="success"
                action={{
                  content: "Change Plan",
                  url: "https://admin.shopify.com/charges/zenmeraki-deskribe-ai/pricing_plans",
                  target: "_top",
                }}
                secondaryAction={{
                  content: "Cancel Plan",
                  onAction: () => submit({}, { method: "POST" }),
                }}
              />
            ) : (
              <Banner
                title="You do not have an active subscription."
                tone="critical"
              />
            )}

            {/* Billing toggle */}
            <div style={{ display: "flex", justifyContent: "center", gap: "8px", margin: "8px 0 4px" }}>
              {(["monthly", "yearly"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setBilling(mode)}
                  style={{
                    padding: "7px 20px",
                    borderRadius: "8px",
                    border: "1px solid #E5E7EB",
                    background: billing === mode ? "#ffffff" : "transparent",
                    fontWeight: billing === mode ? 600 : 400,
                    fontSize: "13px",
                    cursor: "pointer",
                    color: billing === mode ? "#111827" : "#6B7280",
                    boxShadow: billing === mode ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {mode === "monthly" ? "Pay monthly" : "Pay yearly"}
                  {mode === "yearly" && (
                    <span style={{ background: "#F0FDF4", color: "#15803D", fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "20px" }}>
                      Save 30%
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Pricing Cards */}
           <div style={{marginBottom:"20px"}}>
             <PricingCards
              billing={billing}
              currentPlanId={subscription?.name?.toLowerCase().replace(" plan", "")}
              onSelectPlan={(planId) => {
                window.open(
                  "https://admin.shopify.com/charges/zenmeraki-deskribe-ai/pricing_plans",
                  "_top"
                );
              }}
            />
           </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}