import { Worker } from "bullmq";

import { db } from "../../lib/db.server";
import { logger } from "../../lib/logger.server";
import { getRedis } from "../../lib/redis.server";
import { clampError } from "./applyProduct";
import { processApplyJob } from "./processor";
import type { ApplyJobData } from "./types";
import { LIMITS } from "./types";

let applyWorker: Worker<ApplyJobData> | null = null;

export function startApplyWorker() {
  if (applyWorker) return applyWorker;

  applyWorker = new Worker<ApplyJobData>("apply", processApplyJob, {
    connection: getRedis() as any,
    concurrency: LIMITS.CONCURRENCY,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  });

  applyWorker.on("completed", (job, result) => {
    logger.info("[apply.worker] completed", {
      bullJobId: job.id,
      applyId: job.data.applyId,
      jobId: job.data.jobId,
      shopDomain: job.data.shopDomain,
      result,
    });
  });

  applyWorker.on("failed", async (job, error) => {
    if (job) {
      const finalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);

      if (finalAttempt) {
        await db.applyJob.updateMany({
          where: {
            id: job.data.applyId,
            shopDomain: job.data.shopDomain,
            jobId: job.data.jobId,
            status: { notIn: ["COMPLETED", "CANCELLED"] },
          },
          data: {
            status: "FAILED",
            errorMessage: "Worker exhausted retries.",
          },
        });
      }

      logger.error("[apply.worker] failed", {
        bullJobId: job.id,
        applyId: job.data.applyId,
        jobId: job.data.jobId,
        shopDomain: job.data.shopDomain,
        attemptsMade: job.attemptsMade,
        errorMessage: clampError(error),
      });
    }
  });

  applyWorker.on("error", (error) => {
    logger.error("[apply.worker] error", {
      errorMessage: clampError(error),
    });
  });

  return applyWorker;
}
