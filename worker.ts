import { startGenerationWorker } from "./app/worker/generation.worker"; // ← fixed: was "./app/worker/generation.worker"

const worker = startGenerationWorker();

console.log("🚀 Worker process started, queue: generation");
console.log("[worker] REDIS_URL:", process.env.REDIS_URL?.replace(/:\/\/.*@/, "://***@") ?? "NOT SET");

worker.on("ready", () => {
  console.log("[worker] ready and listening for jobs");
});

process.on("SIGINT", async () => {
  console.log("[worker] SIGINT received, closing...");
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[worker] SIGTERM received, closing...");
  await worker.close();
  process.exit(0);
});