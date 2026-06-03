import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const { hasActivePayment, appSubscriptions } = await billing.check();

  // If no active subscription, send them to billing page
  if (!hasActivePayment) {
    return redirect("/app/billing");
  }

  return redirect("/app");
};