// FILE: app/workers/start-generation-worker.ts
import dotenv from "dotenv";
const result = dotenv.config();

console.log("[worker] Dotenv load result:", result.error ? result.error : "success");
console.log("[worker] REDIS_URL:", process.env.REDIS_URL ? "present (starts with " + process.env.REDIS_URL.substring(0, 15) + ")" : "MISSING");
console.log("[worker] DATABASE_URL:", process.env.DATABASE_URL ? "present" : "MISSING");

await import("../lib/queue.server");
await import("../worker/generation.worker");

console.log("[worker] generation worker booted");

