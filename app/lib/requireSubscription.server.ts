export async function requireSubscription(_request: Request) {
  // SingleMerchant / custom-distribution apps cannot use Shopify Billing API.
  // So for this app, do nothing and allow access.
  return;
}