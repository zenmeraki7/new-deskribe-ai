import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { syncShopPlan } from "../utils/credits.server";
import {
  recordWebhookDelivery,
  markWebhookProcessed,
  shouldProcessWebhookEvent,
  webhookEventAtFromRequest,
} from "../utils/webhooks.server";

function subscriptionNameFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, any>;
  return (
    record.app_subscription?.name ??
    record.appSubscription?.name ??
    record.subscription?.name ??
    record.name ??
    null
  );
}

function subscriptionStatusFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, any>;
  const status =
    record.app_subscription?.status ??
    record.appSubscription?.status ??
    record.subscription?.status ??
    record.status ??
    null;
  return typeof status === "string" ? status.toUpperCase() : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const eventAt = webhookEventAtFromRequest(request, payload);
  const delivery = await recordWebhookDelivery({
    request,
    shop,
    topic,
    payload,
    eventAt,
  });
  if (delivery.duplicate) {
    console.log(`[webhook] Duplicate ${topic} ignored for ${shop}`);
    return new Response(null, { status: 200 });
  }

  const shouldProcess = await shouldProcessWebhookEvent({ shop, topic, eventAt });
  if (!shouldProcess) {
    console.log(`[webhook] Older ${topic} ignored for ${shop}`);
    await markWebhookProcessed(delivery.webhookId);
    return new Response(null, { status: 200 });
  }

  const subscriptionStatus = subscriptionStatusFromPayload(payload);
  const subscriptionName =
    subscriptionStatus && subscriptionStatus !== "ACTIVE"
      ? "free"
      : subscriptionNameFromPayload(payload);

  // Mapping note: current Shopify billing config names the middle tier
  // "Advanced Plan", which maps to local Plan.name = "standard".
  // Confirm this if subscription names in shopify.server.ts change.
  // This webhook is the source of truth for plan changes. syncShopPlan keeps
  // creditsUsed and cycle dates intact; only the live plan/limit changes.
  await syncShopPlan(shop, subscriptionName, { createIfMissing: false });
  await markWebhookProcessed(delivery.webhookId);

  return new Response(null, { status: 200 });
};
