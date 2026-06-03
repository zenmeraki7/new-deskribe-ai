import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// AFTER
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  const { hasActivePayment } = await billing.check({
    plans: [
      "Basic Plan",
      "Basic Plan Yearly",
      "Advanced Plan",
      "Advanced Plan Yearly",
      "Pro Plan",
      "Pro Plan Yearly",
    ],
    isTest: true,
  });

  if (!hasActivePayment) {
    return redirect("/app/billing");
  }

  return redirect("/app");
};