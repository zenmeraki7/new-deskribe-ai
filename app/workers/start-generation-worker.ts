import "dotenv/config";
import "../lib/queue.server";
import { startGenerationWorker } from "../worker/generation.worker"; // ← fixed: was "../worker/generation.worker"

const worker = startGenerationWorker();

console.log("[worker] generation worker booted, queue: generation");
console.log("[worker] REDIS_URL:", process.env.REDIS_URL?.replace(/:\/\/.*@/, "://***@") ?? "NOT SET");

worker.on("ready", () => {
  console.log("[worker] ready and listening for jobs");
});