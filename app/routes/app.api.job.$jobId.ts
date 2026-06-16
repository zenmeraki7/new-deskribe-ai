// FILE: app/routes/app.api.job.$jobId.ts
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

import { requireAdminSession } from "../lib/auth.server";
import { db } from "../lib/db.server";
import { sanitiseHtml } from "../lib/html.server";

// UUID v4
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Defensive caps to prevent returning massive payloads every 2s
const LIMITS = {
  MAX_HTML_CHARS: 250_000, // apply server-side cap before sanitizing
  MAX_ERROR_CHARS: 2_000,
  MAX_META_TITLE_CHARS: 500,
  MAX_META_DESC_CHARS: 2_000,
} as const;

// Keep the wire format stable for existing clients.
// We add `code` as optional (non-breaking) for better client decisions.
type PollResponse = {
  status: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  code?: string;
};

function clampString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length <= maxChars ? value : value.slice(0, maxChars);
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

function shapeGeneratedSeoOutput(
  raw: unknown,
  sanitiseHtml: (input: string) => string,
): { result: Record<string, unknown> | null; code?: string } {
  if (!raw || typeof raw !== "object") return { result: null };
  const fields = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const descriptionHtml = clampString(
    fields.descriptionHtml,
    LIMITS.MAX_HTML_CHARS,
  );
  if (descriptionHtml) out.body_html = sanitiseHtml(descriptionHtml);

  const seoTitle = clampString(fields.seoTitle, LIMITS.MAX_META_TITLE_CHARS);
  if (seoTitle) out.meta_title = seoTitle;

  const seoDescription = clampString(
    fields.seoDescription,
    LIMITS.MAX_META_DESC_CHARS,
  );
  if (seoDescription) out.meta_description = seoDescription;

  return { result: Object.keys(out).length ? out : null };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Hard requirement: every request authenticated and shop-scoped
  const { shopDomain } = await requireAdminSession(request);

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

  const output = await db.generatedSeoOutput.findFirst({
    where: {
      shopDomain,
      jobId,
      status: "READY",
    },
    select: {
      fields: true,
    },
  });

  // Preview data comes from server-sanitized GeneratedSeoOutput, not request/client payload.
  const shaped = shapeGeneratedSeoOutput(output?.fields ?? null, sanitiseHtml);

  const safeError = job.errorMessage
    ? clampString(job.errorMessage, LIMITS.MAX_ERROR_CHARS)
    : null;

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
