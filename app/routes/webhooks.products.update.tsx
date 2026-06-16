import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const productId =
    typeof payload?.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;

  if (!productId) {
    return new Response(null, { status: 200 });
  }

  try {
    await db.generationJob.updateMany({
      where: {
         shopDomain: shop, productId, status: "COMPLETED" 
      },
       data: { isStale: true },
    });
  } catch (error) {
    console.error(`Failed to process PRODUCTS_UPDATE for ${shop}`, error);
  }

  return new Response(null, { status: 200 });
};
