// FILE: app/workers/start-generation-worker.ts
import "dotenv/config";

import "../lib/queue.server.ts";
import "../worker/generation.worker.ts";

console.log("[worker] generation worker booted");
console.log("REDIS_URL =", process.env.REDIS_URL);