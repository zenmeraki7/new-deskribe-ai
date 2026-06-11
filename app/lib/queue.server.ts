// FILE: app/lib/queue.server.ts
// app/lib/queue.server.ts
import { Queue } from "bullmq";
import { getRedis } from "./redis.server.ts";

console.log("[bullmq-audit][queue] defining queue", {
  queueName: "generation",
  redisUrlPresent: Boolean(process.env.REDIS_URL),
});

export const generationQueue = new Queue("generation", {
  connection: getRedis(),
});

console.log("[bullmq-audit][queue] queue constructed", {
  queueName: generationQueue.name,
});

