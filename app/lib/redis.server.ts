import IORedis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redis__: IORedis | undefined;
}

export function getRedis() {
  if (!global.__redis__) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("[redis] REDIS_URL is not set");

    console.log(
      "[redis] creating connection, TLS:",
      url.startsWith("rediss://"),
    );

    global.__redis__ = new IORedis(url, {
      maxRetriesPerRequest: null, // required for BullMQ
      enableReadyCheck: false,    // BullMQ recommendation
      lazyConnect: false,
      connectTimeout: 10000,

      // Only enable TLS when URL scheme is rediss://
      tls: url.startsWith("rediss://") ? {} : undefined,

      retryStrategy(times) {
        if (times > 10) {
          console.error("[redis] giving up after 10 retries");
          return null;
        }
        const delay = Math.min(times * 100, 3000);
        console.log(`[redis] reconnect attempt ${times}, delay ${delay}ms`);
        return delay;
      },
    });

    global.__redis__.on("connect", () => console.log("[redis] connected"));
    global.__redis__.on("ready", () => console.log("[redis] ready"));
    global.__redis__.on("error", (err) =>
      console.error("[redis] error:", err.message),
    );
    global.__redis__.on("close", () => console.warn("[redis] connection closed"));
    global.__redis__.on("end", () => console.warn("[redis] connection ended"));
  }

  return global.__redis__;
}