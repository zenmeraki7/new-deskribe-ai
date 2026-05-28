// FILE: app/components/diffViewer/limits.js

/**
 * Diff Viewer Limits
 *
 * Security + performance contract:
 * - These are UI-level defensive caps only.
 * - Server MUST enforce stricter validation, sanitization (allowlist),
 *   size limits, and plan-based quotas.
 * - All values are frozen to prevent runtime mutation.
 */

const RAW_LIMITS = {
  /**
   * Caps HTML passed into analysis/diff/highlighting.
   * Prevents parsing hangs and large DOM operations.
   */
  MAX_HTML_CHARS_FOR_ANALYSIS: 250_000, // ~250KB

  /**
   * LCS diff complexity is O(N*M).
   * We aggressively cap token counts to avoid quadratic explosions.
   */
  MAX_TOKENS_FOR_DIFF: 2_500,

  /**
   * Keyword highlighting safeguards.
   * Prevents RegExp catastrophic backtracking and DOM traversal blowups.
   */
  MAX_KEYWORDS: 40,
  MAX_KEYWORD_CHARS: 64,
  MAX_TOTAL_KEYWORD_CHARS: 800,

  /**
   * Iframe display bounds (SafeHtmlFrame).
   * Must always be clamped between MIN and MAX.
   */
  MAX_IFRAME_HEIGHT: 600,
  MIN_IFRAME_HEIGHT: 160,

  /**
   * Display-only caps for raw source mode.
   */
  MAX_SOURCE_CHARS: 300_000,

  /**
   * Hard stop for keyword match highlighting to prevent DOM lockups.
   */
  MAX_KEYWORD_MATCHES_PER_DOC: 25_000,
};

/**
 * Validate numeric limits at module load.
 * Fail fast if any value is unsafe or misconfigured.
 */
function validateLimits(obj) {
  const numericKeys = Object.keys(obj);

  for (const key of numericKeys) {
    const value = obj[key];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Invalid LIMITS.${key}: must be a finite number`);
    }

    if (value <= 0) {
      throw new Error(`Invalid LIMITS.${key}: must be > 0`);
    }

    // Hard upper bounds to prevent accidental unsafe configs.
    if (value > 5_000_000) {
      throw new Error(`Invalid LIMITS.${key}: exceeds safe upper bound`);
    }
  }

  if (obj.MIN_IFRAME_HEIGHT >= obj.MAX_IFRAME_HEIGHT) {
    throw new Error("Invalid LIMITS: MIN_IFRAME_HEIGHT must be < MAX_IFRAME_HEIGHT");
  }

  if (obj.MAX_TOTAL_KEYWORD_CHARS < obj.MAX_KEYWORDS) {
    throw new Error(
      "Invalid LIMITS: MAX_TOTAL_KEYWORD_CHARS must accommodate MAX_KEYWORDS"
    );
  }
}

validateLimits(RAW_LIMITS);

/**
 * Deep freeze to prevent mutation in runtime (defensive hardening).
 */
function deepFreeze(o) {
  Object.freeze(o);
  Object.getOwnPropertyNames(o).forEach((prop) => {
    const value = o[prop];
    if (
      value &&
      typeof value === "object" &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  });
  return o;
}

export const LIMITS = deepFreeze({ ...RAW_LIMITS });

/**
 * Safe helpers for clamping at call sites.
 * These are optional utilities to standardize enforcement.
 */

export function clampHtmlForAnalysis(html) {
  if (typeof html !== "string") return "";
  if (html.length <= LIMITS.MAX_HTML_CHARS_FOR_ANALYSIS) return html;
  return html.slice(0, LIMITS.MAX_HTML_CHARS_FOR_ANALYSIS);
}

export function clampSourceHtml(html) {
  if (typeof html !== "string") return "";
  if (html.length <= LIMITS.MAX_SOURCE_CHARS) return html;
  return html.slice(0, LIMITS.MAX_SOURCE_CHARS);
}

export function clampIframeHeight(height) {
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return LIMITS.MIN_IFRAME_HEIGHT;
  }
  return Math.min(
    LIMITS.MAX_IFRAME_HEIGHT,
    Math.max(LIMITS.MIN_IFRAME_HEIGHT, height)
  );
}
