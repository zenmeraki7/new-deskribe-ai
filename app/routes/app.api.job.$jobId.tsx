// FILE: app/routes/app.api.job.$jobId.tsx
// Lightweight polling endpoint (JSON only).
// Security & scale hardening:
// - Authenticated (authenticate.admin) + shop-scoped DB read
// - Returns server-sanitized HTML only (allowlist sanitizer from html.server.ts)
// - Response shaping + payload caps (prevents huge JSON / accidental PII spill)
// - Explicit no-store caching
// - Strict runtime validation of stored JSON (no silent contract drift)
//
// NOTE: This endpoint is polled frequently. Keep it fast: 1 indexed read.

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";

import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";
import { sanitiseHtml } from "../lib/html.server";

// UUID v4
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Defensive caps to prevent returning massive payloads every 2s
const LIMITS = {
  MAX_HTML_CHARS: 250_000, // apply server-side cap before sanitizing
  MAX_ERROR_CHARS: 2_000,
  MAX_KEYWORDS: 80,
  MAX_KEYWORD_CHARS: 64,
  MAX_META_TITLE_CHARS: 500,
  MAX_META_DESC_CHARS: 2_000,
  MAX_HEADLINE_CHARS: 500,
  MAX_SOCIAL_CHARS: 2_000,
} as const;

// Keep the wire format stable for existing clients.
// We add `code` as optional (non-breaking) for better client decisions.
type PollResponse = {
  status: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  code?: string;
};

// Strictly validate the stored JSON result (no silent parse fallbacks)
// (We still clamp/sanitize on output even if valid.)
const StoredDraftSchema = z
  .object({
    body_html: z.string().optional(),
    meta_title: z.string().optional(),
    meta_description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    primary_keyword: z.string().optional(),
    headline: z.string().optional(),
    social_caption: z.string().optional(),
  })
  .strict();

function clampString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function normalizeStringArray(value: unknown, maxItems: number, maxEachChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, maxEachChars);
    if (!s) continue;

    const lower = s.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function noStoreHeaders() {
  // Prevent CDN/browser caching of poll responses
  // "private" helps shared caches avoid storing even if misconfigured.
  return {
    "Cache-Control": "no-store, private, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Type": "application/json; charset=utf-8",
  } as const;
}

/**
 * Result shaping:
 * - Only return the fields the UI needs (avoid accidental schema expansion leaks)
 * - Ensure body_html is server-sanitized (allowlist sanitizer)
 * - Enforce safe defaults and caps
 */
function shapeResult(raw: unknown): { result: Record<string, unknown> | null; code?: string } {
  if (raw == null) return { result: null };

  const parsed = StoredDraftSchema.safeParse(raw);
  if (!parsed.success) {
    // Contract drift or corrupted DB content: fail closed and do not return raw.
    return { result: null, code: "INVALID_RESULT_SHAPE" };
  }

  const r = parsed.data;

  const bodyHtmlRaw = clampString(r.body_html, LIMITS.MAX_HTML_CHARS);
  const body_html = bodyHtmlRaw ? sanitiseHtml(bodyHtmlRaw) : undefined;

  // Keep these as plain strings; UI renders them as text.
  const meta_title = clampString(r.meta_title, LIMITS.MAX_META_TITLE_CHARS) || undefined;
  const meta_description = clampString(r.meta_description, LIMITS.MAX_META_DESC_CHARS) || undefined;
  const primary_keyword = clampString(r.primary_keyword, LIMITS.MAX_KEYWORD_CHARS) || undefined;
  const headline = clampString(r.headline, LIMITS.MAX_HEADLINE_CHARS) || undefined;
  const social_caption = clampString(r.social_caption, LIMITS.MAX_SOCIAL_CHARS) || undefined;

  const keywords = normalizeStringArray(r.keywords, LIMITS.MAX_KEYWORDS, LIMITS.MAX_KEYWORD_CHARS);
  const keywordsOrUndef = keywords.length ? keywords : undefined;

  // Return only allowlisted keys. (Everything else is dropped.)
  const out: Record<string, unknown> = {};
  if (body_html !== undefined) out.body_html = body_html;
  if (meta_title !== undefined) out.meta_title = meta_title;
  if (meta_description !== undefined) out.meta_description = meta_description;
  if (keywordsOrUndef !== undefined) out.keywords = keywordsOrUndef;
  if (primary_keyword !== undefined) out.primary_keyword = primary_keyword;
  if (headline !== undefined) out.headline = headline;
  if (social_caption !== undefined) out.social_caption = social_caption;

  // If nothing useful exists, treat as null.
  return { result: Object.keys(out).length ? out : null };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Hard requirement: every request authenticated and shop-scoped
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const jobId = params.jobId;

  // Shape guard (fail closed)
  if (!jobId || !UUID_V4_RE.test(jobId)) {
    const res: PollResponse = {
      status: "FAILED",
      result: null,
      errorMessage: "Invalid job ID",
      code: "INVALID_JOB_ID",
    };
    return json(res, {
      status: 400,
      headers: noStoreHeaders(),
    });
  }

  // Single indexed read — shopDomain scoping is the security boundary
  const job = await db.generationJob.findFirst({
    where: { id: jobId, shopDomain },
    select: {
      status: true,
      result: true,
      errorMessage: true,
    },
  });

  if (!job) {
    const res: PollResponse = {
      status: "FAILED",
      result: null,
      errorMessage: "Job not found",
      code: "JOB_NOT_FOUND",
    };
    return json(res, {
      status: 404,
      headers: noStoreHeaders(),
    });
  }

  // Sanitize + shape the result payload defensively
  const shaped = shapeResult(job.result);

  const safeError = job.errorMessage ? clampString(job.errorMessage, LIMITS.MAX_ERROR_CHARS) : null;

  const res: PollResponse = {
    status: String(job.status),
    result: shaped.result,
    errorMessage: safeError,
    ...(shaped.code ? { code: shaped.code } : {}),
  };

  return json(res, {
    headers: noStoreHeaders(),
  });
}
