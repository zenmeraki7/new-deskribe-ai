import dotenv from "dotenv";
dotenv.config();

import { Queue } from "bullmq";
import IORedis from "ioredis";

async function main() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  console.log("[check-queue] REDIS_URL:", redisUrl.substring(0, 30) + "...");

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queue = new Queue("generation", { connection: connection as any });

  const waiting = await queue.getWaiting();
  const active = await queue.getActive();
  const completed = await queue.getCompleted();
  const failed = await queue.getFailed();
  const delayed = await queue.getDelayed();

  console.log("\n=== BullMQ Queue State ===");
  console.log("Waiting:", waiting.length);
  console.log("Active:", active.length);
  console.log("Completed:", completed.length);
  console.log("Failed:", failed.length);
  console.log("Delayed:", delayed.length);

  if (waiting.length > 0) {
    console.log("\n=== Waiting Jobs ===");
    for (const job of waiting) {
      console.log(`  Job ID: ${job.id}, Name: ${job.name}, Data:`, JSON.stringify(job.data));
    }
  }

  if (failed.length > 0) {
    console.log("\n=== Failed Jobs ===");
    for (const job of failed) {
      console.log(`  Job ID: ${job.id}, Name: ${job.name}, FailedReason: ${job.failedReason}`);
    }
  }

  if (active.length > 0) {
    console.log("\n=== Active Jobs ===");
    for (const job of active) {
      console.log(`  Job ID: ${job.id}, Name: ${job.name}`);
    }
  }

  if (completed.length > 0) {
    console.log("\n=== Completed Jobs (last 5) ===");
    for (const job of completed.slice(0, 5)) {
      console.log(`  Job ID: ${job.id}, Name: ${job.name}, ReturnValue:`, JSON.stringify(job.returnvalue));
    }
  }

  await queue.close();
  await connection.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
