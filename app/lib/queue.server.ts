// FILE: app/lib/queue.server.ts
// app/lib/queue.server.ts
import { Queue, type JobsOptions } from "bullmq";
import { getRedis } from "./redis.server";

export const GENERATION_JOB_ATTEMPTS = 3;

export const generationJobDefaults: JobsOptions = {
  attempts: GENERATION_JOB_ATTEMPTS,
  backoff: {
    type: "exponential",
    delay: 5_000,
  },
  removeOnComplete: {
    age: 60 * 60 * 24,
    count: 1_000,
  },
  removeOnFail: false,
};

export const generationQueue = new Queue("generation", {
  connection: getRedis() as any,
  defaultJobOptions: generationJobDefaults,
});
