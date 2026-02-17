// FILE: app/lib/queue.server.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * BullMQ requires a shared Redis connection (or identical connection options)
 * for Queue + Worker. Your previous file only exported the Queue, so the Worker
 * couldn't reliably reuse the same connection and may never connect.
 *
 * This module exports:
 * - `redisConnection`: the singleton Redis client
 * - `generationQueue`: the Queue("generation")
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

// BullMQ recommended settings:
// - maxRetriesPerRequest: null (let BullMQ handle retries)
// - enableReadyCheck: false can help with some managed redis; keep true unless issues
export const redisConnection = new IORedis(requireEnv("REDIS_URL"), {
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  // Don't crash the process, but log loudly.
  console.error("[redis] connection error:", err?.message ?? err);
});

export const generationQueue = new Queue("generation", {
  connection: redisConnection,
});
