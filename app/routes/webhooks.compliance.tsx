import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`[Compliance Webhook] topic=${topic} shop=${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // dskribe-ai only uses write_products scope — no customer PII stored.
      // If you ever store customer data in future, provide it to the merchant here.
      console.log("[CUSTOMERS_DATA_REQUEST] No customer data stored.", payload);
      break;

    case "CUSTOMERS_REDACT":
      // Delete any stored customer data for payload.customer.id
      // dskribe-ai: no customer data to redact currently.
      console.log("[CUSTOMERS_REDACT] No customer data to redact.", payload);
      break;

    case "SHOP_REDACT":
      // Shop uninstalled 48hrs ago — delete all shop data from your DB here.
      // dskribe-ai: add Prisma delete calls if you store shop-level data.
      console.log("[SHOP_REDACT] Shop data redaction for shop_id:", (payload as any).shop_id);
      break;

    default:
      console.warn("[Compliance Webhook] Unhandled topic:", topic);
      return new Response("Unhandled topic", { status: 400 });
  }

  return new Response(null, { status: 200 });
};