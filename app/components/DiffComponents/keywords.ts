// FILE: app/components/diffViewer/keywords.ts
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

const MAX_REGEX_PATTERN_CHARS = 5_000;
const MAX_KEYWORD_OCCURRENCES = 5_000;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize + cap keywords defensively.
 * - Trims
 * - Enforces caps
 * - De-dupes case-insensitively
 * - Preserves original casing of first occurrence
 */
export function normalizeKeywords(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const value of raw) {
    if (typeof value !== "string") continue;

    const trimmed = value.trim();
    if (!trimmed) continue;

    const keyword = trimmed.slice(0, LIMITS.MAX_KEYWORD_CHARS);
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) continue;

    const nextTotal = totalChars + keyword.length;

    if (out.length >= LIMITS.MAX_KEYWORDS) break;
    // Keep scanning: a shorter later keyword may still fit the remaining budget.
    if (nextTotal > LIMITS.MAX_TOTAL_KEYWORD_CHARS) continue;

    out.push(keyword);
    seen.add(lower);
    totalChars = nextTotal;
  }

  return out;
}

/**
 * Build a safe regex from keywords that have already been normalized and capped.
 */
export function buildKeywordRegexFromNormalized(
  keywords: readonly string[],
): RegExp | null {
  if (!keywords.length) return null;

  const escaped = keywords
    .filter((keyword) => keyword.length > 0)
    .map(escapeRegExp);

  if (!escaped.length) return null;

  escaped.sort((a, b) => b.length - a.length);

  const approxPatternSize =
    escaped.reduce((acc, value) => acc + value.length, 0) + escaped.length;

  if (approxPatternSize > MAX_REGEX_PATTERN_CHARS) {
    return null;
  }

  return new RegExp(`(${escaped.join("|")})`, "gi");
}

/**
 * Build a safe, bounded regex for keyword highlighting.
 */
export function buildKeywordRegex(keywords: unknown): RegExp | null {
  const normalized = normalizeKeywords(keywords);
  return buildKeywordRegexFromNormalized(normalized);
}

export function buildKeywordOccurrenceRegex(keyword: string): RegExp | null {
  if (!keyword) return null;
  return new RegExp(escapeRegExp(keyword), "gi");
}

export function countKeywordOccurrencesRaw(
  regex: RegExp | null,
  text: unknown,
  cap = MAX_KEYWORD_OCCURRENCES,
): number {
  const haystack = typeof text === "string" ? text : "";
  if (!haystack) return 0;
  if (!(regex instanceof RegExp)) return 0;

  const hardCap =
    typeof cap === "number" && Number.isFinite(cap) && cap > 0
      ? Math.min(cap, MAX_KEYWORD_OCCURRENCES)
      : MAX_KEYWORD_OCCURRENCES;

  const originalLastIndex = regex.lastIndex;
  regex.lastIndex = 0;

  try {
    let count = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(haystack)) !== null) {
      count++;
      if (match.index === regex.lastIndex) regex.lastIndex++;
      if (count >= hardCap) break;
    }

    return count;
  } finally {
    regex.lastIndex = originalLastIndex;
  }
}

/**
 * Count occurrences with a hard cap.
 */
export function countKeywordOccurrences(text: unknown, keyword: unknown): number {
  const haystack = typeof text === "string" ? text : "";
  if (!haystack) return 0;

  if (typeof keyword !== "string") return 0;
  const normalized = normalizeKeywords([keyword]);
  const regex = normalized[0]
    ? buildKeywordOccurrenceRegex(normalized[0])
    : null;

  return countKeywordOccurrencesRaw(regex, haystack);
}

/**
 * Count total matches across a regex, capped.
 * Useful for highlight routines that need to bail out before DOM work explodes.
 */
export function countRegexMatches(
  regex: RegExp | null | undefined,
  text: unknown,
  cap = LIMITS.MAX_KEYWORD_MATCHES_PER_DOC,
): number {
  const haystack = typeof text === "string" ? text : "";
  if (!haystack) return 0;
  if (!(regex instanceof RegExp)) return 0;

  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const safeRegex = new RegExp(regex.source, flags);
  safeRegex.lastIndex = 0;

  const hardCap =
    typeof cap === "number" && Number.isFinite(cap) && cap > 0
      ? Math.min(cap, LIMITS.MAX_KEYWORD_MATCHES_PER_DOC)
      : LIMITS.MAX_KEYWORD_MATCHES_PER_DOC;

  let count = 0;
  let match: RegExpExecArray | null;

  while ((match = safeRegex.exec(haystack)) !== null) {
    count++;
    if (match.index === safeRegex.lastIndex) safeRegex.lastIndex++;
    if (count >= hardCap) break;
  }

  return count;
}
