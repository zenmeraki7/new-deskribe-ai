import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireAdminSession } from "../lib/auth.server";

// AFTER
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await requireAdminSession(request);

  const isTestBilling = process.env.IS_TEST_BILLING === "true";


  const { hasActivePayment } = await billing.check({
    plans: [
      "Basic Plan",
      "Basic Plan Yearly",
      "Advanced Plan",
      "Advanced Plan Yearly",
      "Pro Plan",
      "Pro Plan Yearly",
    ],
   isTest: isTestBilling
  });

  if (!hasActivePayment) {
    return redirect("/app/billing");
  }

  return redirect("/app");
};
