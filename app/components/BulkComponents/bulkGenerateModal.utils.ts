import {
  FORMAT_OPTIONS,
  MAX_KEYWORD_CHARS,
  MAX_KEYWORDS,
  MAX_KEYWORDS_INPUT_CHARS,
  VIBE_OPTIONS,
  type Format,
  type KeywordParseResult,
  type Vibe,
} from "./bulkGenerateModal.types";

export function createIdempotencyKey() {
  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    throw new Error("crypto.randomUUID unavailable");
  }

  return globalThis.crypto.randomUUID();
}

export function clampText(value: string, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function normalizeKeyword(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_KEYWORD_CHARS);
}

export function parseKeywords(input: string): KeywordParseResult {
  const truncatedInput = input.length > MAX_KEYWORDS_INPUT_CHARS;
  const clampedInput = clampText(input, MAX_KEYWORDS_INPUT_CHARS);
  const rawParts = clampedInput.split(",");
  const seen = new Set<string>();
  const accepted: string[] = [];
  let ignoredCount = 0;
  let truncatedKeywordsCount = 0;

  for (const rawPart of rawParts) {
    const trimmed = rawPart.trim();
    if (!trimmed) continue;

    if (trimmed.length > MAX_KEYWORD_CHARS) truncatedKeywordsCount += 1;

    const normalized = normalizeKeyword(trimmed);
    const key = normalized.toLowerCase();

    if (!normalized || seen.has(key)) {
      ignoredCount += 1;
      continue;
    }

    if (accepted.length >= MAX_KEYWORDS) {
      ignoredCount += 1;
      continue;
    }

    seen.add(key);
    accepted.push(normalized);
  }

  return { accepted, ignoredCount, truncatedInput, truncatedKeywordsCount };
}

export function isValidVibe(value: string): value is Vibe {
  return VIBE_OPTIONS.some((option) => option.value === value);
}

export function isValidFormat(value: string): value is Format {
  return FORMAT_OPTIONS.some((option) => option.value === value);
}

export function formatDuration(seconds?: number) {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return null;
  if (seconds < 60) {
    const rounded = Math.ceil(seconds);
    return `${rounded} second${rounded === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
