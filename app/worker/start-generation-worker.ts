// FILE: app/worker/start-generation-worker.ts
//
// FIX: import path was "../worker/generation.worker.ts"
//      The file lives at app/workers/generation.worker.ts (same directory),
//      so the correct relative path is "./generation.worker".
//      The .ts extension suffix was also wrong for ts-node / tsx runners.

import "dotenv/config";
import "../lib/queue.server";
import { startGenerationWorker } from "./generation.worker"; // ← FIXED

const worker = startGenerationWorker();

console.log("[worker] generation worker booted, queue: generation");
console.log(
  "[worker] REDIS_URL:",
  process.env.REDIS_URL?.replace(/:\/\/.*@/, "://***@") ?? "NOT SET",
);

worker.on("ready", () => {
  console.log("[worker] ready and listening for jobs");
});

// Keep the process alive and surface unhandled rejections clearly
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
});

process.on("SIGTERM", async () => {
  console.log("[worker] SIGTERM — closing worker gracefully");
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[worker] SIGINT — closing worker gracefully");
  await worker.close();
  process.exit(0);
});