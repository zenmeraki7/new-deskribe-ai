export const GENERATION_WORKER_TERMINAL_STATUSES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

// COMPLETED means generation is done and the draft is awaiting merchant review.
export const JOB_REVIEW_STATUSES = ["COMPLETED"] as const;

export const JOB_ACTIVE_STATUSES = ["PENDING", "PROCESSING"] as const;
export const JOB_WORKABLE_STATUSES = ["PENDING"] as const;

export const GENERATION_MAX_ATTEMPTS = 5;
export const GENERATION_RETRY_BASE_DELAY_MS = 2_000;

export type GenerationJobTerminalStatus =
  (typeof GENERATION_WORKER_TERMINAL_STATUSES)[number];
export type GenerationJobReviewStatus = (typeof JOB_REVIEW_STATUSES)[number];
export type GenerationJobWorkableStatus =
  (typeof JOB_WORKABLE_STATUSES)[number];

export function isScheduledRetry(job: { status: string; attempts: number }) {
  return job.status === "PENDING" && job.attempts > 0;
}
