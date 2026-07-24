import { getRedis } from "./redis.server";

export const PLANS = ["free", "basic", "advanced", "pro"] as const;
export type Plan = (typeof PLANS)[number];

const SHOP_PER_MINUTE_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 5000;
const SHOP_KEY_TTL_SECONDS = 2 * 60;
const GLOBAL_KEY_TTL_SECONDS = 26 * 60 * 60;

function utcMinuteString(): string {
  return new Date().toISOString().slice(0, 16);
}

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function shopRedisKey(shopDomain: string): string {
  return `rl:shop:${shopDomain}:${utcMinuteString()}`;
}

function globalRedisKey(): string {
  return `rl:global:${utcDateString()}`;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: "shop_limit" | "global_limit";
}

export function resolvePlan(
  priceAmount: number | null | undefined,
): Plan {
  if (priceAmount == null) return "free";
  if (priceAmount >= 99.99) return "pro";
  if (priceAmount >= 29.99) return "advanced";
  if (priceAmount >= 14.99) return "basic";
  return "free";
}

export async function checkAndIncrementRateLimit(
  shopDomain: string,
  _plan?: Plan,
): Promise<RateLimitResult> {
  if (!shopDomain) {
    throw new Error("Missing shop context");
  }

  const shopKey = shopRedisKey(shopDomain);
  const globalKey = globalRedisKey();

  const pipeline = getRedis().pipeline();
  pipeline.incr(shopKey);
  pipeline.expire(shopKey, SHOP_KEY_TTL_SECONDS, "NX" as any);
  pipeline.incr(globalKey);
  pipeline.expire(globalKey, GLOBAL_KEY_TTL_SECONDS, "NX" as any);
  const results = await pipeline.exec();

  const shopCount = results?.[0]?.[1] as number;
  const globalCount = results?.[2]?.[1] as number;

  if (globalCount > GLOBAL_DAILY_LIMIT) {
    await getRedis().pipeline().decr(shopKey).decr(globalKey).exec();
    return {
      allowed: false,
      reason: "global_limit",
    };
  }

  if (shopCount > SHOP_PER_MINUTE_LIMIT) {
    await getRedis().pipeline().decr(shopKey).decr(globalKey).exec();
    return {
      allowed: false,
      reason: "shop_limit",
    };
  }

  return { allowed: true };
}

export async function checkAndIncrementKeywordLimit(
  shopDomain: string,
  plan?: Plan,
): Promise<RateLimitResult> {
  return checkAndIncrementRateLimit(shopDomain, plan);
}

export function canUseCustomTemplates(plan: Plan): boolean {
  return plan === "advanced" || plan === "pro";
}
