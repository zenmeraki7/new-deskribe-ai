// FILE: app/lib/creditService.server.ts

import { getRedis } from "./redis.server";
import { db } from "./db.server";

export const PLAN_CREDITS = {
  free:     300,
  basic:    6000,
  advanced: 30000,
  pro:      100000,
} as const;

export const CREDIT_COSTS = {
  productDescription: 1,
  seoGeneration: 2,
  keywordSuggestion: 0.5,
  bulkGeneration: 1, // per product
} as const;

export type Plan = keyof typeof PLAN_CREDITS;

export function resolvePlan(subscriptionName: string | null | undefined): Plan {
  if (!subscriptionName) return "free";
  const lower = subscriptionName.toLowerCase();
  if (lower.includes("pro"))      return "pro";
  if (lower.includes("advanced")) return "advanced";
  if (lower.includes("basic"))    return "basic";
  return "free";
}

function currentBillingPeriod(): string {
  // Use YYYY-MM as the billing period
  const date = new Date();
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shopRedisKey(shopDomain: string): string {
  return `credits:shop:${shopDomain}:${currentBillingPeriod()}`;
}

const KEY_TTL_SECONDS = 31 * 24 * 60 * 60; // 31 days to cover the month

export interface CreditCheckResult {
  allowed: boolean;
  reason?: "insufficient_credits";
  used: number;
  limit: number;
  cost: number;
}

export async function checkAndDeductCredits(
  shopDomain: string,
  plan: Plan,
  cost: number
): Promise<CreditCheckResult> {
  const shopLimit = PLAN_CREDITS[plan];
  const shopKey = shopRedisKey(shopDomain);
  const period = currentBillingPeriod();

  // Get current usage from Redis
  const currentStr = await getRedis().get(shopKey);
  const currentUsed = currentStr ? parseFloat(currentStr) : 0;

  if (currentUsed + cost > shopLimit) {
    return {
      allowed: false,
      reason: "insufficient_credits",
      used: currentUsed,
      limit: shopLimit,
      cost
    };
  }

  // Deduct/Increment usage in Redis
  const newUsedStr = await getRedis().incrbyfloat(shopKey, cost);
  const newUsed = parseFloat(newUsedStr as any);
  await getRedis().expire(shopKey, KEY_TTL_SECONDS, "NX" as any);

  // Persist to DB asynchronously
  persistUsageToDB(shopDomain, plan, period, cost).catch((err) => {
    console.error("[credit-service] DB persist failed (non-fatal):", err);
  });

  return { allowed: true, used: newUsed, limit: shopLimit, cost };
}

export async function refundCredits(
  shopDomain: string,
  plan: Plan,
  cost: number
): Promise<void> {
  const shopKey = shopRedisKey(shopDomain);
  
  // Decrease in Redis
  await getRedis().incrbyfloat(shopKey, -cost);

  // Decrease in DB
  const period = currentBillingPeriod();
  try {
    await db.shopCreditUsage.updateMany({
      where: {
        shopDomain,
        billingPeriod: period,
        creditsUsed: { gte: cost },
      },
      data: {
        creditsUsed: { decrement: cost },
      },
    });
  } catch (err) {
    console.error(`[creditService] refund failed for ${shopDomain}:`, err);
  }
}

async function persistUsageToDB(
  shopDomain: string,
  plan: Plan,
  billingPeriod: string,
  cost: number
): Promise<void> {
  await db.$transaction([
    db.shopCreditUsage.upsert({
      where: { shopDomain_billingPeriod: { shopDomain, billingPeriod } },
      create: { shopDomain, billingPeriod, creditsUsed: cost, plan },
      update: { creditsUsed: { increment: cost }, plan },
    }),
    db.globalCreditUsage.upsert({
      where: { billingPeriod },
      create: { billingPeriod, creditsUsed: cost },
      update: { creditsUsed: { increment: cost } },
    }),
  ]);
}

export async function getShopUsageThisMonth(shopDomain: string): Promise<number> {
  const key = shopRedisKey(shopDomain);
  const val = await getRedis().get(key);
  return val ? parseFloat(val) : 0;
}

export function canUseCustomTemplates(plan: Plan): boolean {
  return plan === "advanced" || plan === "pro";
}
