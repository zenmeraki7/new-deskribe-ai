import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

interface AppSubscriptionPayload {
  app_subscription?: {
    id?: string;
    name?: string;
    status?: string;
  } | null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const subscription = (payload as AppSubscriptionPayload | null)?.app_subscription ?? null;

  console.log("[APP_SUBSCRIPTIONS_UPDATE]", {
    shop,
    id: subscription?.id ?? null,
    name: subscription?.name ?? null,
    status: subscription?.status ?? null,
  });

  // TODO: If shop plan state is later cached in the DB, update that record here.
  return new Response(null, { status: 200 });
};