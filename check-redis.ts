// FILE: scripts/check-redis.ts
import { redisConnection } from "./app/lib/queue.server";

async function main() {
  const keys = await redisConnection.keys("bull:generation:*");
  console.log("Total Redis keys:", keys.length);

  const waiting = await redisConnection.lrange("bull:generation:wait", 0, -1);
  const active = await redisConnection.lrange("bull:generation:active", 0, -1);
  const failed = await redisConnection.zrange("bull:generation:failed", 0, -1);
  const completed = await redisConnection.zrange("bull:generation:completed", 0, -1);
  const delayed = await redisConnection.zrange("bull:generation:delayed", 0, -1);

  console.log("Waiting:", waiting);
  console.log("Active:", active);
  console.log("Failed:", failed.length, "jobs");
  console.log("Completed:", completed.length, "jobs");
  console.log("Delayed:", delayed);

  const jobId = "6926fce8-1f77-4b3f-abc1-a6ec8879fb39";
  const jobData = await redisConnection.hgetall(`bull:generation:${jobId}`);
  console.log("\nStuck job data:", jobData);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redisConnection.quit();
  });