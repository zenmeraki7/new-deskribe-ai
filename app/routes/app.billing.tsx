import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { Banner, Layout, Page, BlockStack } from "@shopify/polaris";
import { authenticate } from "app/shopify.server";
import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useEffect, useState } from "react";
import { PricingCards } from "../components/PricingCards";

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// Map planId + billing mode → the plan name key in shopify.server.ts
const PLAN_NAME_MAP: Record<string, Record<string, string>> = {
  basic:    { monthly: "Basic Plan",    yearly: "Basic Plan Yearly"    },
  advanced: { monthly: "Advanced Plan", yearly: "Advanced Plan Yearly" },
  pro:      { monthly: "Pro Plan",      yearly: "Pro Plan Yearly"      },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const { appSubscriptions } = await withRetry(() => billing.check({
  plans: PLANS,
  isTest: true,
}));
  return json({ subscription: appSubscriptions?.[0] ?? null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request); // get both here, once
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Cancel ────────────────────────────────────────────────────────────────
  if (intent === "cancel") {
    const { appSubscriptions } = await withRetry(() => billing.check());
    if (appSubscriptions?.[0]) {
      await withRetry(() => billing.cancel({ subscriptionId: appSubscriptions[0].id }));
    }
    return json({ success: true, intent: "cancel" });
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────
  if (intent === "subscribe") {
    const planId      = formData.get("planId") as string;
    const billingMode = formData.get("billingMode") as string;

    const planName = PLAN_NAME_MAP[planId]?.[billingMode];
    if (!planName) return json({ error: "Invalid plan" }, { status: 400 });

    // Cancel existing subscription before creating new one
    const { appSubscriptions } = await withRetry(() => billing.check());
    if (appSubscriptions?.[0]) {
      await withRetry(() => billing.cancel({ subscriptionId: appSubscriptions[0].id }));
    }

    const returnUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing`;

    await billing.request({
      plan: planName,
      isTest: true,
      returnUrl,
    });
  }

  return json({ success: false });
};

export default function Billing() {
  const { subscription } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");

  // Derive current planId from subscription name for the "Current Plan" badge
  const currentPlanId = (() => {
    const name = subscription?.name?.toLowerCase() ?? "";
    if (name.includes("pro"))      return "pro";
    if (name.includes("advanced")) return "advanced";
    if (name.includes("basic"))    return "basic";
    return "free";
  })();

  const currentBillingInterval: "monthly" | "yearly" = (() => {
    const name = subscription?.name?.toLowerCase() ?? "";
    return name.includes("yearly") ? "yearly" : "monthly";
  })();

  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.intent === "cancel") {
      shopify.toast.show("Plan Successfully Cancelled", {
        duration: 5000,
        isError: false,
      });
    }
  }, [actionData]);

  function handleSelectPlan(planId: string) {
    if (planId === "free") return; // free plan needs no billing
    submit(
      { intent: "subscribe", planId, billingMode: billing },
      { method: "POST" }
    );
  }

  return (
    <Page title="Select a Plan">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {subscription ? (
              <Banner
                title={`Active subscription: ${subscription.name}`}
                tone="success"
                secondaryAction={{
                  content: "Cancel Plan",
                  onAction: () =>
                    submit({ intent: "cancel" }, { method: "POST" }),
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
            <div style={{ marginBottom: "20px" }}>
              <PricingCards
                billing={billing}
                currentPlanId={currentPlanId}
                currentBillingInterval={currentBillingInterval}
                onSelectPlan={handleSelectPlan}
              />
            </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}