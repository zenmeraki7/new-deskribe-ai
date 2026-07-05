// FILE: app/components/diffViewer/keywords.js
import { LIMITS } from "./limits";

/**
 * Keyword utilities (UI-side, analysis/highlighting only)
 *
 * Security contract:
 * - These helpers are NOT a sanitization boundary and must never be used for persistence.
 * - We must avoid regex catastrophic backtracking risks by:
 *   - escaping literals
 *   - sorting by length (longest-first) to reduce alternation overhead
 *   - bounding total pattern size
 *   - using match caps when scanning text
 */

export function escapeRegExp(lit) {
  // Ensure string coercion; then escape metacharacters.
  return String(lit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize + cap keywords defensively.
 * - Trims
 * - Enforces caps
 * - De-dupes case-insensitively
 * - Preserves original casing of first occurrence
 */
export function normalizeKeywords(input) {
  const raw = Array.isArray(input) ? input : [];

  /** @type {string[]} */
  const out = [];
  const seen = new Set(); // lowercased
  let totalChars = 0;

  for (const k of raw) {
    if (typeof k !== "string") continue;

    const trimmed = k.trim();
    if (!trimmed) continue;

    // Cap per-keyword length.
    const kw = trimmed.slice(0, LIMITS.MAX_KEYWORD_CHARS);

    // Reject super short / noisy tokens? Keep permissive; call sites can filter if needed.
    const lower = kw.toLowerCase();
    if (seen.has(lower)) continue;

    // Update caps after dedupe to avoid attackers inflating totalChars with duplicates.
    const nextTotal = totalChars + kw.length;

    if (out.length >= LIMITS.MAX_KEYWORDS) break;
    if (nextTotal > LIMITS.MAX_TOTAL_KEYWORD_CHARS) break;

    out.push(kw);
    seen.add(lower);
    totalChars = nextTotal;
  }

  return out;
}

/**
 * Build a safe, bounded regex for keyword highlighting.
 * - Escapes all literals
 * - Sorts longest-first to reduce alternation ambiguity
 * - Fails closed if pattern would be too large
 */
export function buildKeywordRegex(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  if (!list.length) return null;

  // Normalize again defensively in case caller passed raw input.
  const normalized = normalizeKeywords(list);
  if (!normalized.length) return null;

  const escaped = normalized.map(escapeRegExp).filter(Boolean);
  if (!escaped.length) return null;

  // Sort longest-first: improves match quality and reduces engine work in alternations.
  escaped.sort((a, b) => b.length - a.length);

  // Hard cap the final pattern size to avoid excessive compilation / memory.
  // This is in addition to MAX_TOTAL_KEYWORD_CHARS and per-keyword caps.
  const approxPatternSize = escaped.reduce((acc, s) => acc + s.length, 0) + (escaped.length * 1);
  if (approxPatternSize > 5000) {
    // Fail closed: do not highlight rather than risking slow regex compilation/execution.
    return null;
  }

  // Non-capturing group is slightly lighter; we still need a full match group for consumers.
  // Keep "gi" for global, case-insensitive highlighting.
  return new RegExp(`(${escaped.join("|")})`, "gi");
}

/**
 * Count occurrences with a hard cap.
 * Uses exec loop to support overlapping safety via lastIndex adjustments.
 */
export function countKeywordOccurrences(text, keyword) {
  const haystack = typeof text === "string" ? text : "";
  if (!haystack) return 0;

  const kw = typeof keyword === "string" ? keyword.trim() : "";
  if (!kw) return 0;

  // Build a safe literal regex.
  const re = new RegExp(escapeRegExp(kw), "gi");

  let count = 0;
  let m;

  // Hard cap to avoid pathological cases.
  const HARD_CAP = 5000;

  while ((m = re.exec(haystack)) !== null) {
    count++;
    // Safety: in weird zero-length match cases, force progress.
    if (m.index === re.lastIndex) re.lastIndex++;
    if (count >= HARD_CAP) break;
  }

  return count;
}

/**
 * Count total matches across a regex, capped.
 * Useful for highlight routines that need to bail out before DOM work explodes.
 */
export function countRegexMatches(text, regex, cap = LIMITS.MAX_KEYWORD_MATCHES_PER_DOC) {
  const haystack = typeof text === "string" ? text : "";
  if (!haystack) return 0;
  if (!(regex instanceof RegExp)) return 0;

  // Ensure global to iterate; clone if necessary.
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);

  let count = 0;
  let m;

  const hardCap =
    typeof cap === "number" && Number.isFinite(cap) && cap > 0
      ? Math.min(cap, LIMITS.MAX_KEYWORD_MATCHES_PER_DOC)
      : LIMITS.MAX_KEYWORD_MATCHES_PER_DOC;

  while ((m = re.exec(haystack)) !== null) {
    count++;
    if (m.index === re.lastIndex) re.lastIndex++;
    if (count >= hardCap) break;
  }

  return count;
}
