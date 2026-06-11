import IORedis from "ioredis";

let redis: IORedis | null = null;

export function getRedis() {
  if (!redis) {
    console.log("[redis] creating connection");

   redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,

  tls: {},

  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);

    console.log(
      `[redis] reconnect attempt ${times}, retrying in ${delay}ms`,
    );

    return delay;
  },
});

    redis.on("connect", () => {
      console.log("[redis] connected");
    });

    redis.on("ready", () => {
      console.log("[redis] ready");
    });

    redis.on("reconnecting", () => {
      console.log("[redis] reconnecting...");
    });

    redis.on("close", () => {
      console.log("[redis] connection closed");
    });

    redis.on("end", () => {
      console.log("[redis] connection ended");
    });

    redis.on("error", (err) => {
      console.error("[redis] error:", err);
    });
  }

  return redis;
}