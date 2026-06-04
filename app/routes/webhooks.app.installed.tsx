import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    // Clear all shop-specific data on reinstall
    await db.$transaction([
      db.generationJob.deleteMany({ where: { shopDomain: shop } }),
      db.shopUsage.deleteMany({ where: { shopDomain: shop } }),
      db.customTemplate.deleteMany({ where: { shopDomain: shop } }),
     db.history.deleteMany({ where: { shopDomain: shop } }),
    ]);

    console.log(`Cleared data for reinstalled shop: ${shop}`);
  } catch (error) {
    console.error(`Failed to clear data for ${shop}:`, error);
  }

  return new Response(null, { status: 200 });
};