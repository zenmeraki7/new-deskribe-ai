export const MAX_KEYWORDS_INPUT_CHARS = 800;
export const MAX_KEYWORDS = 20;
export const MAX_SUGGESTED_KEYWORDS = 10;
export const MAX_KEYWORD_CHARS = 64;
export const LARGE_BULK_THRESHOLD = 50;
export const HUGE_BULK_THRESHOLD = 100;

export const VIBE_OPTIONS = [
  { label: "Casual", value: "casual" },
  { label: "Luxury", value: "luxury" },
  { label: "Technical", value: "technical" },
  { label: "Playful", value: "playful" },
  { label: "Minimalist", value: "minimalist" },
] as const;

export const FORMAT_OPTIONS = [
  { label: "Paragraph", value: "paragraph" },
  { label: "Bullets", value: "bullets" },
  { label: "Hybrid", value: "hybrid" },
] as const;

export type Vibe = (typeof VIBE_OPTIONS)[number]["value"];
export type Format = (typeof FORMAT_OPTIONS)[number]["value"];

export interface BulkResult {
  ok: boolean;
  jobIds?: string[];
  skipped?: string[];
  bulkId?: string | null;
  creditsDeducted?: number;
  newBalance?: number;
  creditsRemaining?: number;
  creditBalanceVersion?: number;
  queuePosition?: number | null;
  estimatedCompletionSeconds?: number;
  error?: string;
  code?: string;
  idempotentReplay?: boolean;
}

export interface BulkKeywordResult {
  ok: boolean;
  keywords?: string[];
  error?: string;
  code?: string;
  creditsRemaining?: number;
  creditsDeducted?: number;
  newBalance?: number | null;
  creditBalanceVersion?: number | null;
  idempotentReplay?: boolean;
}

export interface KeywordParseResult {
  accepted: string[];
  ignoredCount: number;
  truncatedInput: boolean;
  truncatedKeywordsCount: number;
}
