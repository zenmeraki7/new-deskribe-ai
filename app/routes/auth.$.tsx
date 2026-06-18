//app/routes/auth.$.tsx
import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireAdminSession } from "../lib/auth.server";

console.log("AUTH ROUTE LOADED");
// AFTER
export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("STEP 1");

  const { billing } = await requireAdminSession(request);

  console.log("STEP 2");

  const isTestBilling = process.env.IS_TEST_BILLING === "true";

  console.log("STEP 3");

  const { hasActivePayment } = await billing.check({
    plans: [
      "Basic Plan",
      "Basic Plan Yearly",
      "Advanced Plan",
      "Advanced Plan Yearly",
      "Pro Plan",
      "Pro Plan Yearly",
    ],
    isTest: isTestBilling,
  });

  console.log("STEP 4", hasActivePayment);

  return redirect("/app");
};
