// app/routes/webhooks.app-uninstalled.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";
import { generationQueue } from "../lib/queue.server"; 
import { deleteShopData } from "../utils/shop-data.server";
import {
  recordWebhookDelivery,
  webhookEventAtFromRequest,
} from "../utils/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const eventAt = webhookEventAtFromRequest(request, payload);
    const delivery = await recordWebhookDelivery({
      request,
      shop,
      topic,
      payload,
      eventAt,
    });
    if (delivery.duplicate) {
      return new Response();
    }

    // Step 1: Find active jobs that have been enqueued to Redis
    const activeJobs = await db.generationJob.findMany({
      where: {
        shopDomain: shop,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true },
    });

    // Step 2: Remove from BullMQ + mark CANCELLED
    if (activeJobs.length > 0) {
      await Promise.allSettled(
        activeJobs.map(async ({ id }) => {
          try {
            const bullJob = await generationQueue.getJob(id); // jobId === job.id (set at enqueue)
            if (bullJob) await bullJob.remove();
          } catch (err) {
            console.warn(`[uninstall] Could not remove Bull job ${id}:`, err);
          }
        })
      );

      await db.generationJob.updateMany({
        where: {
          shopDomain: shop,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        data: { status: "CANCELLED" },
      });

      console.log(`[uninstall] Cancelled ${activeJobs.length} active jobs for ${shop}`);
    }

    // Step 3: Delete all DB rows
    await deleteShopData(shop);

    console.log(`[uninstall] Cleared all data for shop: ${shop}`);
  } catch (error) {
    console.error(`[uninstall] Failed to clear data for ${shop}:`, error);
  }

  return new Response();
};
