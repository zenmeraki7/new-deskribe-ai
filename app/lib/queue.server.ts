// FILE: app/lib/queue.server.ts

import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!);

export const generationQueue = new Queue("generation", {
  connection,
});
