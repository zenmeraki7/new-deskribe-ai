// FILE: app/lib/rate-limit.server.ts

import { getRedis } from "./redis.server";
import { db } from "./db.server";

// ─── Constants ───────────────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  free:     10,
  basic:    200,
  advanced: 1000,
  pro:      Infinity,
} as const;

export const BULK_LIMITS = {
  free:     0,
  basic:    20,
  advanced: 50,
  pro:      Infinity,
} as const;

export const KEYWORD_LIMITS = {
  free: 0,
  basic: 5,
  advanced: 15,
  pro: 50,
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

// ─── Plan resolution ──────────────────────────────────────────────────────────

export function resolvePlan(subscriptionName: string | null | undefined): Plan {
  if (!subscriptionName) return "free";
  const lower = subscriptionName.toLowerCase();
  if (lower.includes("pro"))      return "pro";
  if (lower.includes("advanced")) return "advanced";
  if (lower.includes("basic"))    return "basic";
  return "free";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GLOBAL_DAILY_LIMIT = 500;

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function shopRedisKey(shopDomain: string): string {
  return `rl:shop:${shopDomain}:${utcDateString()}`;
}

function globalRedisKey(): string {
  return `rl:global:${utcDateString()}`;
}

function shopKeywordRedisKey(shopDomain: string): string {
  return `rl:kw:${shopDomain}:${utcDateString()}`;
}

const KEY_TTL_SECONDS = 26 * 60 * 60;

// ─── Rate limit result type ───────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  reason?: "shop_limit" | "global_limit";
  shopUsed?: number;
  shopLimit?: number | typeof Infinity;
}

export interface KeywordLimitResult {
  allowed: boolean;
  reason?: "not_allowed" | "limit_reached";
  used?: number;
  limit?: number | typeof Infinity;
}
// ─── Core check-and-increment ─────────────────────────────────────────────────

export async function checkAndIncrementRateLimit(
  shopDomain: string,
  plan: Plan,
): Promise<RateLimitResult> {
  const shopLimit = PLAN_LIMITS[plan];
  const shopKey = shopRedisKey(shopDomain);
  const globalKey = globalRedisKey();
  const today = utcDateString();

  // Pro plan has no per-shop limit — skip Redis entirely for counting,
  // but still increment global so the circuit-breaker stays accurate.
  if (shopLimit === Infinity) {
    const globalCount = await getRedis().incr(globalKey);
    await getRedis().expire(globalKey, KEY_TTL_SECONDS, "NX" as any);

    if (globalCount > GLOBAL_DAILY_LIMIT) {
      await getRedis().decr(globalKey);
      return {
        allowed: false,
        reason: "global_limit",
        shopUsed: undefined,
        shopLimit: Infinity,
      };
    }

    persistUsageToDB(shopDomain, plan, today).catch((err) => {
      console.error("[rate-limit] DB persist failed (non-fatal):", err);
    });

    return { allowed: true, shopUsed: undefined, shopLimit: Infinity };
  }

  // ── Finite plan: atomic pipeline ──────────────────────────────────────────
  const pipeline = getRedis().pipeline();
  pipeline.incr(shopKey);
  pipeline.expire(shopKey, KEY_TTL_SECONDS, "NX" as any);
  pipeline.incr(globalKey);
  pipeline.expire(globalKey, KEY_TTL_SECONDS, "NX" as any);
  const results = await pipeline.exec();

  const shopCount  = results?.[0]?.[1] as number;
  const globalCount = results?.[2]?.[1] as number;

  // Check global limit first
  if (globalCount > GLOBAL_DAILY_LIMIT) {
    await getRedis().pipeline().decr(shopKey).decr(globalKey).exec();
    return {
      allowed: false,
      reason: "global_limit",
      shopUsed: shopCount - 1,
      shopLimit,
    };
  }

  // Check per-shop limit
  if (shopCount > shopLimit) {
    await getRedis().pipeline().decr(shopKey).decr(globalKey).exec();
    return {
      allowed: false,
      reason: "shop_limit",
      shopUsed: shopCount - 1,
      shopLimit,
    };
  }

  persistUsageToDB(shopDomain, plan, today).catch((err) => {
    console.error("[rate-limit] DB persist failed (non-fatal):", err);
  });

  return { allowed: true, shopUsed: shopCount, shopLimit };
}

export async function refundRateLimit(
  shopDomain: string,
  plan: Plan,
): Promise<void> {
  try {
    await db.shopUsage.updateMany({
      where: {
        shopDomain,
        // Only decrement if above 0 — Prisma doesn't support MAX() directly,
        // so we filter and do a raw decrement.
        generationsUsedToday: { gt: 0 },
      },
      data: {
        generationsUsedToday: { decrement: 1 },
      },
    });
  } catch (err) {
    // Non-fatal: log and continue. A leaked credit is better than
    // a 500 swallowing the real error.
    console.error(`[rateLimiter] refund failed for ${shopDomain}:`, err);
  }
}

export async function checkAndIncrementKeywordLimit(
  shopDomain: string,
  plan: Plan,
): Promise<KeywordLimitResult> {
  const limit = KEYWORD_LIMITS[plan];

  // Free plan — blocked entirely, no Redis needed
  if (limit === 0) {
    return { allowed: false, reason: "not_allowed", used: 0, limit: 0 };
  }

  // Pro plan — unlimited, no Redis needed
  if (limit === Infinity) {
    return { allowed: true, used: undefined, limit: Infinity };
  }

  // Finite plans — use Redis counter
  const key = shopKeywordRedisKey(shopDomain);
  const count = await getRedis().incr(key);
  await getRedis().expire(key, KEY_TTL_SECONDS, "NX" as any);

  if (count > limit) {
    await getRedis().decr(key); // roll back
    return { allowed: false, reason: "limit_reached", used: count - 1, limit };
  }

  return { allowed: true, used: count, limit };
}
// ─── DB persistence ───────────────────────────────────────────────────────────

async function persistUsageToDB(
  shopDomain: string,
  plan: Plan,
  date: string,
): Promise<void> {
  await db.$transaction([
    db.shopUsage.upsert({
      where: { shopDomain_date: { shopDomain, date } },
      create: { shopDomain, date, count: 1, plan },
      update: { count: { increment: 1 }, plan },
    }),
    db.globalUsage.upsert({
      where: { date },
      create: { date, count: 1 },
      update: { count: { increment: 1 } },
    }),
  ]);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export async function getShopUsageToday(shopDomain: string): Promise<number> {
  const key = shopRedisKey(shopDomain);
  const val = await getRedis().get(key);
  return val ? parseInt(val, 10) : 0;
}

export function canUseCustomTemplates(plan: Plan): boolean {
  return plan === "advanced" || plan === "pro";
}