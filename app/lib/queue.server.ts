// FILE: app/lib/queue.server.ts
// app/lib/queue.server.ts
import { Queue } from "bullmq";
import { getRedis } from "./redis.server";

export const generationQueue = new Queue("generation", {
  connection: getRedis(),
});