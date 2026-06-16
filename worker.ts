import "dotenv/config";

import { startApplyWorker } from "./app/worker/apply.worker";
import { startGenerationWorker } from "./app/worker/generation.worker";

const generationWorker = startGenerationWorker();
const applyWorker = startApplyWorker();

console.log("[worker] Worker process started, queues: generation, apply");
console.log(
  "[worker] REDIS_URL:",
  process.env.REDIS_URL?.replace(/:\/\/.*@/, "://***@") ?? "NOT SET",
);

generationWorker.on("ready", () => {
  console.log("[worker] generation worker ready and listening for jobs");
});

applyWorker.on("ready", () => {
  console.log("[worker] apply worker ready and listening for jobs");
});

process.on("SIGINT", async () => {
  console.log("[worker] SIGINT received, closing...");
  await generationWorker.close();
  await applyWorker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[worker] SIGTERM received, closing...");
  await generationWorker.close();
  await applyWorker.close();
  process.exit(0);
});
