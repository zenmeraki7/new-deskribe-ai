// FILE: app/routes/app.jobs.constants.ts

/**
 * Jobs route constants.
 *
 * SECURITY CONTRACT:
 * - These constants are server-side guardrails.
 * - Do NOT trust client-provided pagination, IDs, or batch sizes.
 * - All loader/action handlers must enforce these caps.
 */

// Pagination (server-enforced; client cannot override upper bound)
export const PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50; // hard upper bound if query param is introduced later

// Keep status strings centralized and strongly typed.
export const ACTIVE_STATUSES = ["PENDING", "PROCESSING"] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

// Polling interval for UI (purely advisory; server must not rely on this)
export const POLL_INTERVAL_MS = 3_000;

// Strict UUID v4 (used for jobId validation; fail closed if mismatch)
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Server-side safety caps
 * - Protect DB + queue from mass-cancel or batch operations.
 */

// Maximum jobs that can be cancelled in a single "cancel all" action.
export const CANCEL_ALL_HARD_CAP = 500;

// BullMQ removal batch size (kept small to avoid Redis spikes).
export const BULLMQ_REMOVE_BATCH = 25;

// Absolute cap for destructive operations even if DB contains more.
export const MAX_DESTRUCTIVE_OPERATION_BATCH = 1_000;

/**
 * Validate invariants at module load to prevent unsafe config drift.
 */
function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid constant ${name}: must be a positive finite number`);
  }
}

assertPositive("PAGE_SIZE", PAGE_SIZE);
assertPositive("MAX_PAGE_SIZE", MAX_PAGE_SIZE);
assertPositive("POLL_INTERVAL_MS", POLL_INTERVAL_MS);
assertPositive("CANCEL_ALL_HARD_CAP", CANCEL_ALL_HARD_CAP);
assertPositive("BULLMQ_REMOVE_BATCH", BULLMQ_REMOVE_BATCH);
assertPositive("MAX_DESTRUCTIVE_OPERATION_BATCH", MAX_DESTRUCTIVE_OPERATION_BATCH);

// Logical invariants
if (MAX_PAGE_SIZE < PAGE_SIZE) {
  throw new Error("Invalid constants: MAX_PAGE_SIZE must be >= PAGE_SIZE");
}

if (CANCEL_ALL_HARD_CAP > MAX_DESTRUCTIVE_OPERATION_BATCH) {
  throw new Error(
    "Invalid constants: CANCEL_ALL_HARD_CAP cannot exceed MAX_DESTRUCTIVE_OPERATION_BATCH",
  );
}
