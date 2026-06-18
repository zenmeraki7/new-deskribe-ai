//app/shopify.server.ts
import "@shopify/shopify-app-remix/adapters/node";
import {
 ApiVersion,
  AppDistribution,
  DeliveryMethod,
  shopifyApp,
  BillingInterval,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { db } from "./lib/db.server";


const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: (process.env.SHOPIFY_APP_URL || "").trim().replace(/\/$/, ""),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(db),
  distribution: AppDistribution.AppStore,

  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
     webhooks: {
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/app-uninstalled",
  },

  APP_SCOPES_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/app/scopes_update",
  },

  PRODUCTS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/products/update",
  },
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/compliance",
  },
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/compliance",
  },
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/compliance",
  },
},
 hooks: {
  afterAuth: async ({ session }) => {
    await shopify.registerWebhooks({ session });
  },
},
    
  billing: {
    "Basic Plan": {
      lineItems: [
        {
          amount: 9.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          trialDays: 0,  
        },
      ],
    },
    "Basic Plan Yearly": {
      lineItems: [
        {
          amount: 83.92,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          trialDays: 0,  
        },
      ],
    },
    "Advanced Plan": {
      lineItems: [
        {
          amount: 17.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          trialDays: 0,  
        },
      ],
    },
    "Advanced Plan Yearly": {
      lineItems: [
        {
          amount: 151.12,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          trialDays: 0,  
        },
      ],
    },
    "Pro Plan": {
      lineItems: [
        {
          amount: 24.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          trialDays: 0,  
        },
      ],
    },
    "Pro Plan Yearly": {
      lineItems: [
        {
          amount: 209.92,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          trialDays: 0,  
        },
      ],
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;