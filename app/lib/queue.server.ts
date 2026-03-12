// FILE: app/lib/queue.server.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const redisUrl = requireEnv("REDIS_URL");

const isTls = redisUrl.startsWith("rediss://");

export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
  ...(isTls ? { tls: {} } : {}),
});

redisConnection.on("connect", () => {
  console.log("[redis] connected");
});

redisConnection.on("ready", () => {
  console.log("[redis] ready");
});

redisConnection.on("error", (err) => {
  console.error("[redis] connection error:", err?.message ?? err);
});

export const generationQueue = new Queue("generation", {
  connection: redisConnection,
});