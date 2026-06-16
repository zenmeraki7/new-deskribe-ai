import crypto from "node:crypto";
import { isIP } from "node:net";

import { db } from "./db.server";
import { getRedis } from "./redis.server";

export const PLANS = ["free", "basic", "advanced", "pro"] as const;
export type Plan = (typeof PLANS)[number];

const SHOP_PER_MINUTE_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 5000;
const SHOP_KEY_TTL_SECONDS = 2 * 60;
const GLOBAL_KEY_TTL_SECONDS = 26 * 60 * 60;
const KEYWORD_BURST_LIMIT = 5;
const KEYWORD_DAILY_LIMIT = 100;
const KEYWORD_BURST_WINDOW_MS = 60 * 1000;
const KEYWORD_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEYWORD_LIMIT_TTL_SECONDS = 25 * 60 * 60;
const KEYWORD_USER_BURST_LIMIT = 5;
const KEYWORD_USER_DAILY_LIMIT = 100;
const KEYWORD_IP_BURST_LIMIT = 15;
const KEYWORD_IP_DAILY_LIMIT = 300;

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

export type KeywordSuggestionRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

export type KeywordSuggestionRateLimitIdentity = {
  userId: string;
  clientIp: string;
};

function firstValidIp(value: string | null) {
  if (!value) return null;

  for (const candidate of value.split(",")) {
    const normalized = candidate.trim().replace(/^\[|\]$/g, "");
    if (isIP(normalized)) return normalized;
  }

  return null;
}

export function getTrustedClientIp(request: Request) {
  const cloudflareIp = firstValidIp(request.headers.get("cf-connecting-ip"));
  if (cloudflareIp) return cloudflareIp;

  const flyIp = firstValidIp(request.headers.get("fly-client-ip"));
  if (flyIp) return flyIp;

  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwardedIp = firstValidIp(request.headers.get("x-forwarded-for"));
    if (forwardedIp) return forwardedIp;

    const realIp = firstValidIp(request.headers.get("x-real-ip"));
    if (realIp) return realIp;
  }

  return "unknown";
}

function rateLimitFingerprint(kind: "user" | "ip", value: string) {
  const secret =
    process.env.RATE_LIMIT_HASH_SECRET ??
    process.env.SHOPIFY_API_SECRET ??
    "local-development-rate-limit-secret";

  if (
    process.env.NODE_ENV === "production" &&
    secret === "local-development-rate-limit-secret"
  ) {
    throw new Error(
      "RATE_LIMIT_HASH_SECRET or SHOPIFY_API_SECRET is required in production",
    );
  }

  return crypto
    .createHmac("sha256", secret)
    .update(`${kind}:${value}`)
    .digest("hex")
    .slice(0, 32);
}

export function resolvePlan(subscriptionName: string | null | undefined): Plan {
  if (!subscriptionName) return "free";
  const lower = subscriptionName.toLowerCase();
  if (lower.includes("pro")) return "pro";
  if (lower.includes("advanced")) return "advanced";
  if (lower.includes("basic")) return "basic";
  return "free";
}

export async function checkRateLimit(
  shopDomain: string,
  _plan?: Plan,
): Promise<RateLimitResult> {
  if (!shopDomain) {
    throw new Error("Missing shop context");
  }

  const shopKey = shopRedisKey(shopDomain);
  const globalKey = globalRedisKey();
  const [shopValue, globalValue] = await getRedis().mget(shopKey, globalKey);
  const shopCount = Number(shopValue ?? 0);
  const globalCount = Number(globalValue ?? 0);

  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: "global_limit",
    };
  }

  if (shopCount >= SHOP_PER_MINUTE_LIMIT) {
    return {
      allowed: false,
      reason: "shop_limit",
    };
  }

  return { allowed: true };
}

export async function incrementRateLimit(
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

export async function checkAndIncrementRateLimit(
  shopDomain: string,
  plan?: Plan,
): Promise<RateLimitResult> {
  const limitCheck = await checkRateLimit(shopDomain, plan);

  if (!limitCheck.allowed) {
    return limitCheck;
  }

  return incrementRateLimit(shopDomain, plan);
}

export async function checkAndIncrementKeywordLimit(
  shopDomain: string,
  _plan?: Plan,
): Promise<RateLimitResult> {
  if (!shopDomain) {
    throw new Error("Missing shop context");
  }

  const now = Date.now();
  const keyTag = `{${shopDomain}}`;
  const burstKey = `rl:keyword:${keyTag}:burst`;
  const dailyKey = `rl:keyword:${keyTag}:daily`;
  const member = `${now}:${crypto.randomUUID()}`;
  const script = `
    redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
    redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[2])

    local burstCount = redis.call("ZCARD", KEYS[1])
    local dailyCount = redis.call("ZCARD", KEYS[2])

    if burstCount >= tonumber(ARGV[3]) or dailyCount >= tonumber(ARGV[4]) then
      return 0
    end

    redis.call("ZADD", KEYS[1], ARGV[5], ARGV[6])
    redis.call("ZADD", KEYS[2], ARGV[5], ARGV[6])
    redis.call("EXPIRE", KEYS[1], ARGV[7])
    redis.call("EXPIRE", KEYS[2], ARGV[7])
    return 1
  `;
  const allowed = await getRedis().eval(
    script,
    2,
    burstKey,
    dailyKey,
    String(now - KEYWORD_BURST_WINDOW_MS),
    String(now - KEYWORD_DAILY_WINDOW_MS),
    String(KEYWORD_BURST_LIMIT),
    String(KEYWORD_DAILY_LIMIT),
    String(now),
    member,
    String(KEYWORD_LIMIT_TTL_SECONDS),
  );

  if (Number(allowed) !== 1) {
    return { allowed: false, reason: "shop_limit" };
  }

  try {
    await db.keywordSuggestionAttempt.create({
      data: { shop: shopDomain },
    });
  } catch (error) {
    console.warn("[rate-limit] keyword attempt audit unavailable:", error);
  }

  return { allowed: true };
}

export async function enforceKeywordSuggestionRateLimit({
  shopDomain,
  identity,
}: {
  shopDomain: string;
  plan?: Plan;
  productCount: number;
  idempotencyKey: string;
  identity: KeywordSuggestionRateLimitIdentity;
}): Promise<KeywordSuggestionRateLimitResult> {
  const now = Date.now();
  const keyTag = `{${shopDomain}}`;
  const userHash = rateLimitFingerprint("user", identity.userId);
  const ipHash = rateLimitFingerprint("ip", identity.clientIp);
  const keys = [
    `rl:keyword:${keyTag}:shop:burst`,
    `rl:keyword:${keyTag}:shop:daily`,
    `rl:keyword:${keyTag}:user:${userHash}:burst`,
    `rl:keyword:${keyTag}:user:${userHash}:daily`,
    `rl:keyword:${keyTag}:ip:${ipHash}:burst`,
    `rl:keyword:${keyTag}:ip:${ipHash}:daily`,
  ];
  const member = `${now}:${crypto.randomUUID()}`;
  const script = `
    local limits = {
      tonumber(ARGV[3]), tonumber(ARGV[4]),
      tonumber(ARGV[5]), tonumber(ARGV[6]),
      tonumber(ARGV[7]), tonumber(ARGV[8])
    }
    local retryAt = 0

    for i = 1, #KEYS do
      local cutoff = i % 2 == 1 and ARGV[1] or ARGV[2]
      local window = i % 2 == 1 and tonumber(ARGV[9]) or tonumber(ARGV[10])
      redis.call("ZREMRANGEBYSCORE", KEYS[i], "-inf", cutoff)

      if redis.call("ZCARD", KEYS[i]) >= limits[i] then
        local oldest = redis.call("ZRANGE", KEYS[i], 0, 0, "WITHSCORES")
        if oldest[2] then
          retryAt = math.max(retryAt, tonumber(oldest[2]) + window)
        end
      end
    end

    if retryAt > 0 then
      return retryAt
    end

    for i = 1, #KEYS do
      redis.call("ZADD", KEYS[i], ARGV[11], ARGV[12])
      redis.call("EXPIRE", KEYS[i], ARGV[13])
    end
    return 0
  `;
  const retryAt = Number(
    await getRedis().eval(
      script,
      keys.length,
      ...keys,
      String(now - KEYWORD_BURST_WINDOW_MS),
      String(now - KEYWORD_DAILY_WINDOW_MS),
      String(KEYWORD_BURST_LIMIT),
      String(KEYWORD_DAILY_LIMIT),
      String(KEYWORD_USER_BURST_LIMIT),
      String(KEYWORD_USER_DAILY_LIMIT),
      String(KEYWORD_IP_BURST_LIMIT),
      String(KEYWORD_IP_DAILY_LIMIT),
      String(KEYWORD_BURST_WINDOW_MS),
      String(KEYWORD_DAILY_WINDOW_MS),
      String(now),
      member,
      String(KEYWORD_LIMIT_TTL_SECONDS),
    ),
  );

  if (retryAt > 0) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    };
  }

  try {
    await db.keywordSuggestionAttempt.create({
      data: { shop: shopDomain },
    });
  } catch (error) {
    console.warn("[rate-limit] keyword attempt audit unavailable:", error);
  }

  return { ok: true };
}

function planCacheKey(shopDomain: string) {
  return `billing-plan:${shopDomain}`;
}

export async function getCachedPlan(shopDomain: string): Promise<Plan | null> {
  try {
    const value = await getRedis().get(planCacheKey(shopDomain));
    return value && PLANS.includes(value as Plan) ? (value as Plan) : null;
  } catch (error) {
    console.warn("[rate-limit] plan cache read unavailable:", error);
    return null;
  }
}

export async function setCachedPlan(
  shopDomain: string,
  plan: Plan,
  { ttlSeconds }: { ttlSeconds: number },
) {
  try {
    await getRedis().set(
      planCacheKey(shopDomain),
      plan,
      "EX",
      Math.max(1, Math.floor(ttlSeconds)),
    );
  } catch (error) {
    console.warn("[rate-limit] plan cache write unavailable:", error);
  }
}

export function canUseCustomTemplates(plan: Plan): boolean {
  return plan === "advanced" || plan === "pro";
}
