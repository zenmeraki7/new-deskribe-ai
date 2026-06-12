import IORedis from "ioredis";

declare global {
  var __redis: IORedis | undefined;
}

export function getRedis() {
  if (!globalThis.__redis) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    globalThis.__redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      },
    });

    globalThis.__redis.on("connect", () => {
      console.log("[redis] connected");
    });

    globalThis.__redis.on("ready", () => {
      console.log("[redis] ready");
    });

    globalThis.__redis.on("error", (err) => {
      console.error("[redis] error:", err);
    });
  }

  return globalThis.__redis;
}