// FILE: app/routes/app.products.$productId.constants.ts

/**
 * Route-level constants for /app/products/:productId
 *
 * SECURITY CONTRACT:
 * - All IDs must be validated against these regexes before use.
 * - All retry / polling values are advisory; server logic must still fail closed.
 * - Hard caps prevent abuse via large payloads or retry storms.
 */

// -----------------------------------------------------------------------------
// ID validation
// -----------------------------------------------------------------------------

// Strict Shopify Product GID (Admin API)
export const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;

// Legacy numeric ID (if ever accepted internally; must be converted to GID server-side)
export const SHOPIFY_NUMERIC_ID_RE = /^\d+$/;

// UUID v4 only (jobId, versionId, etc.)
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// Job state
// -----------------------------------------------------------------------------

export const ACTIVE_JOB_STATUSES = ["PENDING", "PROCESSING"] as const;
export type ActiveJobStatus = (typeof ACTIVE_JOB_STATUSES)[number];

// Only consider jobs "recently active" within this window (ms)
export const ACTIVE_JOB_LOOKBACK_MS = 10 * 60 * 1000; // 10 minutes

// -----------------------------------------------------------------------------
// Client polling (UI advisory only)
// -----------------------------------------------------------------------------

export const JOB_POLL_INTERVAL_MS = 2_000;
export const JOB_POLL_JITTER_RATIO = 0.25; // ±25%

// -----------------------------------------------------------------------------
// Keyword limits (must align with server validation logic)
// -----------------------------------------------------------------------------

export const KEYWORDS = {
  MAX: 40,
  MAX_EACH_CHARS: 64,
  MAX_TOTAL_CHARS: 800,
} as const;

// -----------------------------------------------------------------------------
// Shopify GraphQL retry settings (route-level best-effort)
// -----------------------------------------------------------------------------

export const SHOPIFY_GQL_RETRY = {
  MAX_ATTEMPTS: 5,
  BASE_DELAY_MS: 300,
  MAX_DELAY_MS: 5_000,
} as const;

// -----------------------------------------------------------------------------
// Invariant checks (fail fast on unsafe config drift)
// -----------------------------------------------------------------------------

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid constant ${name}: must be a positive finite number`);
  }
}

assertPositive("ACTIVE_JOB_LOOKBACK_MS", ACTIVE_JOB_LOOKBACK_MS);
assertPositive("JOB_POLL_INTERVAL_MS", JOB_POLL_INTERVAL_MS);
assertPositive("SHOPIFY_GQL_RETRY.MAX_ATTEMPTS", SHOPIFY_GQL_RETRY.MAX_ATTEMPTS);
assertPositive("SHOPIFY_GQL_RETRY.BASE_DELAY_MS", SHOPIFY_GQL_RETRY.BASE_DELAY_MS);
assertPositive("SHOPIFY_GQL_RETRY.MAX_DELAY_MS", SHOPIFY_GQL_RETRY.MAX_DELAY_MS);

if (JOB_POLL_JITTER_RATIO < 0 || JOB_POLL_JITTER_RATIO > 1) {
  throw new Error("Invalid constant JOB_POLL_JITTER_RATIO: must be between 0 and 1");
}

if (KEYWORDS.MAX <= 0 || KEYWORDS.MAX_EACH_CHARS <= 0 || KEYWORDS.MAX_TOTAL_CHARS <= 0) {
  throw new Error("Invalid KEYWORDS limits: all values must be positive");
}

if (KEYWORDS.MAX_TOTAL_CHARS < KEYWORDS.MAX) {
  throw new Error(
    "Invalid KEYWORDS limits: MAX_TOTAL_CHARS must be >= MAX to avoid impossible configs",
  );
}
