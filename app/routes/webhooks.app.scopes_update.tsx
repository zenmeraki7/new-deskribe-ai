import type { ActionFunctionArgs } from "@remix-run/node";

import { db } from "../lib/db.server";
import { authenticate } from "../shopify.server";
import {
  markWebhookProcessed,
  recordWebhookDelivery,
  shouldProcessWebhookEvent,
  webhookEventAtFromRequest,
} from "../utils/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

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
    return new Response(null, { status: 200 });
  }

  const shouldProcess = await shouldProcessWebhookEvent({ shop, topic, eventAt });
  if (!shouldProcess) {
    await markWebhookProcessed(delivery.webhookId);
    return new Response(null, { status: 200 });
  }

  const currentScopes = Array.isArray(payload.current) ? payload.current : [];

  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: currentScopes.join(",") },
    });
  }

  await markWebhookProcessed(delivery.webhookId);

  return new Response(null, { status: 200 });
};
