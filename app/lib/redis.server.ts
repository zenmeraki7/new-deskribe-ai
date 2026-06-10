import IORedis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redis__: IORedis | undefined;
}

export function getRedis() {
  if (!global.__redis__) {
    global.__redis__ = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,

      // 🔥 IMPORTANT FIXES
      enableReadyCheck: true,
      connectTimeout: 10000,
      lazyConnect: false,

      retryStrategy(times) {
        if (times > 10) return null; // stop infinite retry loops
        return Math.min(times * 100, 3000);
      },
    });

    global.__redis__.on("connect", () => {
      console.log("[redis] connected");
    });

    global.__redis__.on("ready", () => {
      console.log("[redis] ready");
    });

    global.__redis__.on("error", (err) => {
      console.error("[redis] error:", err);
    });

    global.__redis__.on("close", () => {
      console.warn("[redis] connection closed");
    });
  }

  return global.__redis__;
}