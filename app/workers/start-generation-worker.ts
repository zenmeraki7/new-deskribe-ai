// FILE: app/workers/start-generation-worker.ts
import "../lib/queue.server";
import { startGenerationWorker } from "../worker/generation.worker";

startGenerationWorker();
console.log("[worker] generation worker booted");
