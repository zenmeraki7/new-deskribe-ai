import type { AdminGraphql } from "../../lib/shopifyGraphql.server";

export type ApplyJobData = {
  applyId: string;
  shopDomain: string;
  jobId: string;
  productIds: string[];
};

export type ApplyItemStatus =
  | "PENDING"
  | "PROCESSING"
  | "MUTATING"
  | "APPLIED"
  | "SKIPPED"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELLED";

export type ApplyJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "PARTIAL_FAILED"
  | "FAILED"
  | "NEEDS_REVIEW"
  | "CANCELLED";

export type ApplyProductResult =
  | "APPLIED"
  | "SKIPPED"
  | "FAILED"
  | "UNKNOWN"
  | "IN_PROGRESS";

export type GeneratedSeoOutputForApply = {
  id: string;
  productId: string;
  fields: unknown;
  sourceHash: string | null;
  status: string;
};

export type ApplyContext = {
  shopDomain: string;
  applyId: string;
  jobId: string;
  adminGraphql: AdminGraphql;
};

export type ApplyCounts = {
  applied: number;
  skipped: number;
  failed: number;
  unknown: number;
  cancelled: boolean;
};

export const LIMITS = {
  CONCURRENCY: 2,
  MAX_PRODUCTS: 100,
  MAX_ERROR_CHARS: 300,
  SHOP_LOCK_TTL_MS: 15 * 60 * 1000,
  MUTATING_STALE_MS: 10 * 60 * 1000,
  CANCEL_CHECK_INTERVAL: 5,
  PRODUCT_DELAY_MS: 500,
} as const;
