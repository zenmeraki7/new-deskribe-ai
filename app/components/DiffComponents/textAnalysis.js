// FILE: app/components/diffViewer/textAnalysis.js
import { LIMITS, clampHtmlForAnalysis } from "./limits";

/* Analysis ONLY (NOT sanitization). Never use this for saving HTML.
 *
 * Security contract:
 * - This module is for *text extraction / analysis* only.
 * - It MUST NOT be used as a sanitizer or for persistence decisions.
 * - Avoid regex-based "sanitizers" (we only use regex for whitespace normalization).
 */

export function clampString(s, max) {
  if (typeof s !== "string") return "";
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    // Fail-closed: if max is invalid, return empty to avoid unbounded strings.
    return "";
  }
  return s.length <= max ? s : s.slice(0, max);
}

export function normalizeWhitespace(str) {
  const s = typeof str === "string" ? str : "";
  // Keep this regex: it's linear and bounded; not an HTML sanitizer.
  return s.replace(/\s{2,}/g, " ").trim();
}

/**
 * Decode a small allowlist of entities to improve keyword density accuracy.
 * IMPORTANT: This is not a general entity decoder and should stay allowlisted.
 */
export function decodeBasicEntities(str) {
  const s = typeof str === "string" ? str : "";
  // Using split/join avoids regex backtracking risks entirely.
  // Order matters (amp should not run before others).
  return s
    .split("&nbsp;").join(" ")
    .split("&lt;").join("<")
    .split("&gt;").join(">")
    .split("&quot;").join('"')
    .split("&#39;").join("'")
    .split("&amp;").join("&");
}

/**
 * SSR-safe, linear HTML -> text extraction without regex "sanitizers".
 * This is NOT an HTML sanitizer.
 *
 * Notes:
 * - Purposefully linear-time to resist ReDoS-style payloads.
 * - Keeps minimal entity decoding for analysis signal quality.
 */
export function stripTagsLinear(html) {
  const s = typeof html === "string" ? html : "";
  if (!s) return "";

  let out = "";
  let inTag = false;
  let inEntity = false;
  let entity = "";
  let lastWasSpace = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inTag) {
      if (ch === ">") inTag = false;
      continue;
    }

    if (inEntity) {
      entity += ch;
      // Hard cap entity length to keep linear-time and avoid memory blowups.
      if (ch === ";" || entity.length > 12) {
        out += decodeBasicEntities("&" + entity);
        inEntity = false;
        entity = "";
      }
      continue;
    }

    if (ch === "<") {
      inTag = true;
      continue;
    }

    if (ch === "&") {
      inEntity = true;
      entity = "";
      continue;
    }

    // Normalize whitespace inline to avoid a second pass over huge strings.
    const isWs =
      ch === " " ||
      ch === "\n" ||
      ch === "\t" ||
      ch === "\r" ||
      ch === "\f";

    if (isWs) {
      if (!lastWasSpace) out += " ";
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }

  return normalizeWhitespace(out);
}

/**
 * Extract plain text for analysis (keyword density, diff tokens, etc.).
 * Uses DOMParser when available (client-side) and falls back to linear stripping.
 *
 * IMPORTANT: DOMParser is used only for text extraction. We remove dangerous nodes
 * before reading textContent to avoid bizarre edge cases and reduce work.
 */
export function extractTextForAnalysis(html) {
  // Prefer shared clamp helper to enforce module-level invariant consistently.
  const safeHtml = clampHtmlForAnalysis(html ?? "");
  if (!safeHtml) return "";

  // Client-side: DOMParser tends to yield better text fidelity than naive stripping.
  if (typeof window !== "undefined" && typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(safeHtml, "text/html");

      // Remove nodes that can inflate textContent or add noise.
      // (This is not security sanitization; just analysis hygiene.)
      const kill = doc.querySelectorAll("script,style,noscript,iframe,object,embed,svg,math");
      kill.forEach((n) => n.remove());

      // Some docs may not have a body (malformed HTML); fallback safely.
      const text = doc.body?.textContent ?? "";
      return normalizeWhitespace(text);
    } catch {
      // Fall through to linear extraction.
    }
  }

  // SSR / fallback: linear time; safe on hostile input sizes (already clamped).
  return stripTagsLinear(safeHtml);
}

/**
 * Tokenize extracted text with a hard cap to keep downstream diff O(N*M) bounded.
 * Useful for callers that want to avoid accidentally feeding enormous strings into LCS.
 */
export function tokenizeForDiff(html) {
  const text = extractTextForAnalysis(html);
  if (!text) return [];

  // Split on whitespace; this is bounded by MAX_HTML_CHARS_FOR_ANALYSIS and then capped again.
  const tokens = text.split(/\s+/g);
  if (tokens.length <= LIMITS.MAX_TOKENS_FOR_DIFF) return tokens;
  return tokens.slice(0, LIMITS.MAX_TOKENS_FOR_DIFF);
}
