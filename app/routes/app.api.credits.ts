import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { getCreditBalance } from "../lib/creditService.server";
import { requireAdminSession } from "../lib/auth.server";
import { resolvePlan } from "../lib/rateLimiter.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, shopDomain } = await requireAdminSession(request);
  const { appSubscriptions } = await billing.check();
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  const credits = await getCreditBalance(shopDomain, plan);

  return json({
    plan,
    creditsUsed: credits.creditsUsed,
    creditsLimit: credits.creditsLimit,
    creditsRemaining: credits.creditsRemaining,
    resetDate: credits.resetDate.toISOString(),
  });
}
