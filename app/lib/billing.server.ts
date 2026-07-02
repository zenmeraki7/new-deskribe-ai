import type { AdminAuthContext } from "./auth.server";

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

export const isTestBilling = process.env.IS_TEST_BILLING === "true";

export type BillingContext = AdminAuthContext["billing"];
export type BillingCheckResult = Awaited<ReturnType<BillingContext["check"]>>;

export async function checkBilling(
  billing: BillingContext,
): Promise<BillingCheckResult> {
  try {
    return await billing.check({
      plans: BILLING_PLAN_NAMES,
      isTest: isTestBilling,
    });
  } catch (error) {
    const details =
      error && typeof error === "object" && "response" in error
        ? (error as { response?: unknown }).response
        : null;

    console.error("[checkBilling] failed", {
      isTestBilling,
      plans: BILLING_PLAN_NAMES,
      response: details,
    });

    throw error;
  }
}
