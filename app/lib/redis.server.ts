// app/lib/redis.server.ts
import IORedis from "ioredis";

let redis: IORedis | null = null;

export function getRedis() {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      },
    });

    redis.on("connect", () => {
      console.log("[redis] connected");
    });

    redis.on("ready", () => {
      console.log("[redis] ready");
    });

    redis.on("error", (err) => {
      console.error("[redis] error:", err);
    });
  }

  return redis;
}