import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";
import {
  markWebhookProcessed,
  recordWebhookDelivery,
  webhookEventAtFromRequest,
} from "../utils/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

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

  const productId =
    typeof payload?.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;

  if (!productId) {
    await markWebhookProcessed(delivery.webhookId);
    return new Response(null, { status: 200 });
  }

  try {
    await db.generationJob.updateMany({
      where: {
        shopDomain: shop,
        productId,
        status: "COMPLETED",
        ...(eventAt ? { createdAt: { lt: eventAt } } : {}),
      },
       data: { isStale: true },
    });
    await markWebhookProcessed(delivery.webhookId);
  } catch (error) {
    console.error(`Failed to process PRODUCTS_UPDATE for ${shop}`, error);
    throw error;
  }

  return new Response(null, { status: 200 });
};
