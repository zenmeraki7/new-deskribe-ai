import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// AFTER
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  const { hasActivePayment } = await billing.check({
    plans: [
      "Basic Plan",
      "Basic Plan Yearly",
      "Advanced Plan",
      "Advanced Plan Yearly",
      "Pro Plan",
      "Pro Plan Yearly",
    ],

  });

  if (!hasActivePayment) {
   return redirect(`https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing`);
  }

  return redirect("/app");
};