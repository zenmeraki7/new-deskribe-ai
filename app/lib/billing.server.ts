import { authenticate } from "../shopify.server";

function getStoreHandle(shop: string): string {
  return shop.replace(".myshopify.com", "");
}

function getManagedPricingUrl(shop: string, appHandle: string): string {
  return `https://admin.shopify.com/store/${getStoreHandle(shop)}/charges/${appHandle}/pricing_plans`;
}

export async function requireManagedSubscription(request: Request) {
  const appHandle = process.env.SHOPIFY_APP_HANDLE;

  if (!appHandle) {
    throw new Error(
      "Missing SHOPIFY_APP_HANDLE. Set it from the handle in shopify.app.toml.",
    );
  }

  const { billing, redirect, session } = await authenticate.admin(request);
  const { hasActivePayment } = await billing.check();

  if (!hasActivePayment) {
    return redirect(getManagedPricingUrl(session.shop, appHandle), {
      target: "_top",
    });
  }

  return null;
}