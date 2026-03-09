import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { PLANS } from "../lib/plans";

export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);

  const formData = await request.formData();
  const plan = formData.get("plan");

  const selectedPlan =
    plan === "PRO" ? PLANS.PRO : PLANS.BASIC;

  const billingResponse = await billing.request({
    plan: selectedPlan.name,
    isTest: true,
  });

  return redirect(billingResponse.confirmationUrl);
};