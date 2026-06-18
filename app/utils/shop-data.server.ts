import { db } from "../lib/db.server";

export async function deleteShopData(shop: string) {
  await db.$transaction([
    db.generationJob.deleteMany({ where: { shopDomain: shop } }),
    db.shopUsage.deleteMany({ where: { shopDomain: shop } }),
    db.customTemplate.deleteMany({ where: { shopDomain: shop } }),
    db.history.deleteMany({ where: { shopDomain: shop } }),
    db.creditUsageLog.deleteMany({ where: { shop } }),
    db.creditTransaction.deleteMany({ where: { shopId: shop } }),
    db.shopCredit.deleteMany({ where: { shopId: shop } }),
    db.webhookDelivery.deleteMany({ where: { shop } }),
    db.shopWebhookState.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
