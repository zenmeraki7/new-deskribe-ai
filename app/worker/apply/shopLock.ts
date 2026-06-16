import { getRedis } from "../../lib/redis.server";
import { LIMITS } from "./types";

export async function acquireShopLock(shopDomain: string, applyId: string) {
  const redis = getRedis();
  const key = `lock:apply:shop:${shopDomain}`;
  const value = `${applyId}:${Date.now()}`;

  const result = await redis.set(
    key,
    value,
    "PX",
    LIMITS.SHOP_LOCK_TTL_MS,
    "NX",
  );

  if (result !== "OK") {
    throw new Error("Shop already has an active apply job");
  }

  return async () => {
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    await redis.eval(lua, 1, key, value);
  };
}
