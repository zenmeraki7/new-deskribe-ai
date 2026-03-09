import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { PLANS } from "./plans";

export async function requireSubscription(request: Request) {
  const { billing } = await authenticate.admin(request);

  const { hasActivePayment } = await billing.check({
    plans: [PLANS.BASIC.name, PLANS.PRO.name],
    isTest: true,
  });

  if (!hasActivePayment) {
    throw redirect("/app/pricing");
  }
}