// FILE: app/entry.worker.ts
// Node entrypoint to start BullMQ workers.
// Run this as a separate process in production (recommended).
// If you don't start this process, jobs will stay PENDING and polling will show
// "Job queued, starting shortly…".

import "./workers/generation.worker";

// Keep process alive (Worker maintains event loop via Redis connection),
// but this also makes intent explicit.
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
