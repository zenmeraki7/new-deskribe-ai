// app/routes/webhooks.app-uninstalled.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";
import { generationQueue } from "../lib/queue.server"; 

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
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
    await db.$transaction([
      db.generationJob.deleteMany({ where: { shopDomain: shop } }),
      db.shopCreditUsage.deleteMany({ where: { shopDomain: shop } }),
      db.customTemplate.deleteMany({ where: { shopDomain: shop } }),
      db.history.deleteMany({ where: { shopDomain: shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);

    console.log(`[uninstall] Cleared all data for shop: ${shop}`);
  } catch (error) {
    console.error(`[uninstall] Failed to clear data for ${shop}:`, error);
  }

  return new Response();
};