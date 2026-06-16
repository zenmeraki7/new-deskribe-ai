import type { ApplyCounts, ApplyItemStatus, ApplyJobStatus } from "./types";

const terminalItemStatuses = new Set<ApplyItemStatus>([
  "APPLIED",
  "SKIPPED",
  "FAILED",
  "UNKNOWN",
  "CANCELLED",
]);

export function isTerminalItemStatus(
  status: string,
): status is ApplyItemStatus {
  return terminalItemStatuses.has(status as ApplyItemStatus);
}

export function canResetForRetry(status: string) {
  return !["APPLIED", "UNKNOWN", "CANCELLED"].includes(status);
}

export function deriveFinalJobStatus(counts: ApplyCounts): ApplyJobStatus {
  if (counts.cancelled) return "CANCELLED";
  if (counts.unknown > 0) return "NEEDS_REVIEW";
  if (counts.failed > 0 && (counts.applied > 0 || counts.skipped > 0)) {
    return "PARTIAL_FAILED";
  }
  if (counts.failed > 0) return "FAILED";
  return "COMPLETED";
}

export function finalJobErrorMessage(counts: ApplyCounts) {
  if (counts.failed > 0) return `${counts.failed} product(s) failed.`;
  if (counts.unknown > 0) return `${counts.unknown} product(s) need review.`;
  return null;
}
