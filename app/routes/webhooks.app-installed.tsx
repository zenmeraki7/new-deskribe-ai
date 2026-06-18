import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../utils/shop-data.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    // Clear all shop-specific data on reinstall
    await deleteShopData(shop);

    console.log(`Cleared data for reinstalled shop: ${shop}`);
  } catch (error) {
    console.error(`Failed to clear data for ${shop}:`, error);
  }

  return new Response(null, { status: 200 });
};
