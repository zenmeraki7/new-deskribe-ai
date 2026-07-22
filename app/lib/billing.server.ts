// app/lib/billing.server.ts
import type { AdminAuthContext } from "./auth.server";

// Kept only for display/mapping purposes (UI labels, resolvePlan()).
// These are no longer sent to Shopify — Managed Pricing owns the real
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

// --- NEW: map Shopify's numeric managed-pricing plan IDs to your tier handles ---
// The subscription's `name` field under Managed Pricing is NOT a display name —
// it's the numeric plan ID assigned in Partner Dashboard > Pricing plans.
// This ID is stable per plan across every shop (test or live), so it's the only
// reliable way to know which tier a merchant picked. Get these from Partner
// Dashboard (or log `activeSubscriptions` once per plan on a test store, like
// your screenshot shows: 338642, 341682, 341683, 341685, etc.)
export type PlanHandle = "free" | "basic" | "advanced" | "pro";

const PLAN_ID_TO_HANDLE: Record<string, PlanHandle> = {
  [process.env.SHOPIFY_PLAN_ID_FREE ?? ""]: "free",
  [process.env.SHOPIFY_PLAN_ID_BASIC ?? ""]: "basic",
  [process.env.SHOPIFY_PLAN_ID_ADVANCED ?? ""]: "advanced",
  [process.env.SHOPIFY_PLAN_ID_PRO ?? ""]: "pro",
};

/**
 * Resolves which app tier a subscription corresponds to, by matching the
 * subscription's numeric plan ID — NOT by string-matching its name/description.
 * Returns null if the ID isn't recognized (e.g. env vars not set yet, or a
 * stale/legacy plan).
 */
export function resolvePlanHandle(
  subscription: ManagedSubscription | null,
): PlanHandle | null {
  if (!subscription) return null;
  return PLAN_ID_TO_HANDLE[subscription.name] ?? null;
}

type AdminGraphqlClient = AdminAuthContext["admin"]["graphql"];

export interface ManagedSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  lineItems: {
    plan: {
      pricingDetails: {
        price?: { amount: string; currencyCode: string };
      };
    };
  }[];
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
            lineItems {
              plan {
                pricingDetails {
                  ... on AppRecurringPricing {
                    price { amount currencyCode }
                  }
                }
              }
            }
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
      console.warn("[checkBilling] GraphQL errors", { errors: data.errors });
      return { appSubscriptions: [] };
    }

    const appSubscriptions: ManagedSubscription[] =
      data?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    return { appSubscriptions };
  } catch (error) {
    if (error instanceof Response) {
      const body = await error.text().catch(() => "");
      console.error("[checkBilling] failed", { status: error.status, body: body.slice(0, 300) });
    } else {
      console.error("[checkBilling] failed", { error: String(error) });
    }
    return { appSubscriptions: [] };
  }
}