// app/lib/partnerApi.server.ts
//
// Shopify App Pricing (formerly Managed Pricing) moved subscription status
// off the Admin GraphQL API and onto the Partner API. This client wraps that
// query. Requires a Partner API client with "Manage apps" permission.

const PARTNER_API_TOKEN = (process.env.PARTNER_API_TOKEN || "").trim();
const PARTNER_ORGANIZATION_ID = (process.env.PARTNER_ORGANIZATION_ID || "").trim();
const PARTNER_APP_GID = (process.env.PARTNER_APP_GID || "").trim();

// activeSubscription is on the 2026-07 release candidate / "unstable" version.
const PARTNER_API_VERSION = "2026-07";

const PARTNER_API_URL = PARTNER_ORGANIZATION_ID
  ? `https://partners.shopify.com/${PARTNER_ORGANIZATION_ID}/api/${PARTNER_API_VERSION}/graphql.json`
  : "";

export interface ActiveSubscriptionItem {
  handle: string;
  description: string;
  price:
    | { __typename: "FlatRatePrice"; active: boolean; currency: string; amount: string }
    | {
        __typename: "TieredPrice";
        currency: string;
        tiersMode: "VOLUME" | "GRADUATED";
        tiers: { upTo: number | null; amountPerUnit: string; amount: string }[];
      };
}

export interface ActiveSubscription {
  shop: { id: string; myshopifyDomain: string };
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: ActiveSubscriptionItem[];
  pendingUpdate: unknown | null;
  legacySubscriptionId: string | null;
}

/**
 * Fetches the active Shopify App Pricing subscription for a given shop,
 * or null if the shop has no active subscription.
 *
 * `shopGid` must be the Shop GID (e.g. "gid://shopify/Shop/123456789"),
 * not the myshopify domain. Get it from the Admin API with `{ shop { id } }`.
 */
export async function getActiveSubscription(
  shopGid: string,
): Promise<ActiveSubscription | null> {
  if (!PARTNER_API_TOKEN || !PARTNER_API_URL || !PARTNER_APP_GID) {
    console.error("[partnerApi] Missing PARTNER_API_TOKEN / PARTNER_ORGANIZATION_ID / PARTNER_APP_GID env vars");
    return null;
  }

  try {
    const response = await fetch(PARTNER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": PARTNER_API_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query ActiveSubscription($appId: ID!, $shopId: ID!) {
            activeSubscription(appId: $appId, shopId: $shopId) {
              shop { id myshopifyDomain }
              billingPeriod
              cancelAtEndOfCycle
              trialEndsAt
              currentBillingCycle { startTime endTime }
              items {
                handle
                description
                price {
                  __typename
                  ... on FlatRatePrice { active currency amount }
                  ... on TieredPrice { currency tiersMode tiers { upTo amountPerUnit amount } }
                }
              }
              pendingUpdate
              legacySubscriptionId
            }
          }
        `,
        variables: {
          appId: PARTNER_APP_GID,
          shopId: shopGid,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("[partnerApi] activeSubscription request failed", {
        status: response.status,
        body: body.slice(0, 300),
      });
      return null;
    }

    const data = await response.json();

    if (data?.errors?.length) {
      console.error("[partnerApi] GraphQL errors", { errors: data.errors });
      return null;
    }

    return data?.data?.activeSubscription ?? null;
  } catch (error) {
    console.error("[partnerApi] getActiveSubscription failed", { error: String(error) });
    return null;
  }
}