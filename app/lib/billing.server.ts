// app/lib/billing.server.ts
import type { AdminAuthContext } from "./auth.server";

// Kept only for display/mapping purposes (UI labels, resolvePlan()).
// These are no longer sent to Shopify ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Managed Pricing owns the real
// plan definitions in Partner Dashboard. Keep names in sync manually.
export const BILLING_PLAN_NAMES = [
  "Basic Plan",
  "Basic Plan Yearly",
  "Advanced Plan",
  "Advanced Plan Yearly",
  "Pro Plan",
  "Pro Plan Yearly",
] as const;

export type BillingPlanName = (typeof BILLING_PLAN_NAMES)[number];

export const PLAN_NAME_MAP: Record<string, Record<string, BillingPlanName>> = {
  basic: { monthly: "Basic Plan", yearly: "Basic Plan Yearly" },
  advanced: { monthly: "Advanced Plan", yearly: "Advanced Plan Yearly" },
  pro: { monthly: "Pro Plan", yearly: "Pro Plan Yearly" },
};

type AdminGraphqlClient = AdminAuthContext["admin"]["graphql"];

export interface ManagedSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
}

export interface CheckBillingResult {
  appSubscriptions: ManagedSubscription[];
}

/**
 * Reads current subscription state under Shopify Managed Pricing.
 * This is READ-ONLY - there is no in-app subscribe/cancel mutation here.
 * equivalent. Merchants subscribe/cancel entirely on Shopify's hosted
 * pricing page.
 */
export async function checkBilling(
  adminGraphql: AdminGraphqlClient,
): Promise<CheckBillingResult> {
  try {
    const response = await adminGraphql(`
      #graphql
      query CurrentSubscription {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
          }
        }
      }
    `);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.warn("[checkBilling] Shopify rejected subscription query", {
        status: response.status,
        body: bodyText.slice(0, 300),
      });
      return { appSubscriptions: [] };
    }

    const data = await response.json();
    if (data?.errors) {
      console.warn("[checkBilling] GraphQL errors", {
        errors: data.errors,
      });
      return { appSubscriptions: [] };
    }

    const appSubscriptions: ManagedSubscription[] =
      data?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    console.log(
      "[Billing] Active subscriptions:",
      JSON.stringify(appSubscriptions, null, 2),
    );
    return { appSubscriptions };
  } catch (error) {
    if (error instanceof Response) {
      const body = await error.text().catch(() => "");
      console.error("[checkBilling] failed", {
        status: error.status,
        body: body.slice(0, 300),
      });
    } else {
      console.error("[checkBilling] failed", { error: String(error) });
    }
    return { appSubscriptions: [] };
  }
}
