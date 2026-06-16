import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { z } from "zod";

import {
  bulkKeywordAction,
  getKeywordCreditState,
  getKeywordSuggestionReplay,
  type KeywordCreditState,
} from "../lib/bulkKeywordSuggestion.server";
import { requireAdminSession } from "../lib/auth.server";
import { MAX_BULK_PRODUCT_COUNT } from "../lib/bulkLimits";
import { db } from "../lib/db.server";
import {
  enforceKeywordSuggestionRateLimit,
  getCachedPlan,
  getTrustedClientIp,
  resolvePlan,
  setCachedPlan,
  type Plan,
} from "../lib/rateLimiter.server";
import type { AdminGraphql } from "../lib/shopifyGraphql.server";

const MAX_BODY_BYTES = 32_000;
const MAX_FORM_PRODUCT_IDS_CHARS = 25_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

const ProductGidSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/Product\/[1-9]\d{0,18}$/);

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(MAX_IDEMPOTENCY_KEY_CHARS)
  .regex(/^[A-Za-z0-9._:-]+$/);

function dedupeProductIds(ids: string[]) {
  return [...new Set(ids)];
}

const ProductIdsArraySchema = z
  .array(ProductGidSchema)
  .min(1)
  .transform(dedupeProductIds)
  .refine((ids) => ids.length <= MAX_BULK_PRODUCT_COUNT, {
    message: `Maximum ${MAX_BULK_PRODUCT_COUNT} products allowed.`,
  });

const ProductIdsSchema = z.union([
  ProductIdsArraySchema,
  z
    .string()
    .trim()
    .min(1)
    .max(MAX_FORM_PRODUCT_IDS_CHARS)
    .transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid productIds JSON.",
        });
        return z.NEVER;
      }
    })
    .pipe(ProductIdsArraySchema),
]);

const KeywordSuggestionSchema = z
  .object({
    productIds: ProductIdsSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

type KeywordSuggestionInput = z.infer<typeof KeywordSuggestionSchema>;

function responseHeaders(extra?: HeadersInit) {
  return {
    "Cache-Control": "no-store",
    ...extra,
  };
}

function errorJson(
  code: string,
  error: string,
  status: number,
  headers?: HeadersInit,
  creditState: KeywordCreditState = {
    newBalance: null,
    creditBalanceVersion: null,
  },
) {
  return json(
    { ok: false, code, error, ...creditState },
    { status, headers: responseHeaders(headers) },
  );
}

async function creditErrorJson({
  shopDomain,
  plan,
  code,
  error,
  status,
  headers,
}: {
  shopDomain: string;
  plan?: Plan;
  code: string;
  error: string;
  status: number;
  headers?: HeadersInit;
}) {
  const creditState = await getKeywordCreditState({ shopDomain, plan });
  return errorJson(code, error, status, headers, creditState);
}

function safeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    };
  }

  return { message: "Unknown error" };
}

function validateBodySize(request: Request) {
  const raw = request.headers.get("content-length");
  if (!raw) return null;

  const size = Number(raw);

  if (!Number.isFinite(size) || size < 0) {
    return errorJson("INVALID_CONTENT_LENGTH", "Invalid content length.", 400);
  }

  if (size > MAX_BODY_BYTES) {
    return errorJson("PAYLOAD_TOO_LARGE", "Request body too large.", 413);
  }

  return null;
}

function getMediaType(request: Request) {
  return request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
}

async function parseRequestBody(request: Request, shopDomain: string) {
  const mediaType = getMediaType(request);

  if (mediaType === "application/json") {
    return request.json();
  }

  if (
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "multipart/form-data"
  ) {
    return Object.fromEntries(await request.formData());
  }

  console.warn("Keyword suggestion unsupported content type", {
    shopDomain,
    mediaType,
  });

  throw new Response("Unsupported media type", { status: 415 });
}

async function getPlanSafely({
  billing,
  shopDomain,
}: {
  billing: Awaited<ReturnType<typeof requireAdminSession>>["billing"];
  shopDomain: string;
}): Promise<Plan | Response> {
  const cached = await getCachedPlan(shopDomain);
  if (cached) return cached;

  try {
    const { appSubscriptions } = await billing.check();
    const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

    await setCachedPlan(shopDomain, plan, { ttlSeconds: 300 });
    return plan;
  } catch (error) {
    console.error("Keyword suggestion billing check failed", {
      shopDomain,
      error: safeError(error),
    });

    return creditErrorJson({
      shopDomain,
      code: "BILLING_CHECK_FAILED",
      error: "Could not verify billing plan. Please try again.",
      status: 503,
    });
  }
}

async function getRateLimitUserId(sessionId: string) {
  try {
    const storedSession = await db.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    return storedSession?.userId?.toString() ?? `session:${sessionId}`;
  } catch (error) {
    console.warn("Keyword suggestion user identity lookup failed", {
      error: safeError(error),
    });
    return `session:${sessionId}`;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return errorJson("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
      Allow: "POST",
    });
  }

  const bodySizeError = validateBodySize(request);
  if (bodySizeError) return bodySizeError;

  const session = await requireAdminSession(request);
  const { admin, billing, shopDomain } = session;
  const userId = await getRateLimitUserId(session.session.id);
  const resolvedClientIp = getTrustedClientIp(request);
  const clientIp =
    resolvedClientIp === "unknown"
      ? `unavailable-for:${userId}`
      : resolvedClientIp;

  let rawInput: unknown;

  try {
    rawInput = await parseRequestBody(request, shopDomain);
  } catch (error) {
    if (error instanceof Response && error.status === 415) {
      return creditErrorJson({
        shopDomain,
        code: "UNSUPPORTED_MEDIA_TYPE",
        error: "Unsupported content type.",
        status: 415,
      });
    }

    console.error("Keyword suggestion body parse failed", {
      shopDomain,
      error: safeError(error),
    });

    return creditErrorJson({
      shopDomain,
      code:
        getMediaType(request) === "application/json"
          ? "INVALID_JSON"
          : "INVALID_BODY",
      error: "Request body could not be parsed.",
      status: 400,
    });
  }

  const parsed = KeywordSuggestionSchema.safeParse(rawInput);

  if (!parsed.success) {
    return creditErrorJson({
      shopDomain,
      code: "INVALID_INPUT",
      error: "Invalid input.",
      status: 400,
    });
  }

  const data: KeywordSuggestionInput = parsed.data;
  const replay = await getKeywordSuggestionReplay({
    shopDomain,
    idempotencyKey: data.idempotencyKey,
  });

  if (replay) {
    return json(
      {
        ok: true,
        ...replay,
        idempotentReplay: true,
      },
      { headers: responseHeaders() },
    );
  }

  const plan = await getPlanSafely({ billing, shopDomain });
  if (plan instanceof Response) return plan;

  let rateLimit;

  try {
    rateLimit = await enforceKeywordSuggestionRateLimit({
      shopDomain,
      plan,
      productCount: data.productIds.length,
      idempotencyKey: data.idempotencyKey,
      identity: { userId, clientIp },
    });
  } catch (error) {
    console.error("Keyword suggestion rate limit failed", {
      shopDomain,
      error: safeError(error),
    });

    return creditErrorJson({
      shopDomain,
      plan,
      code: "RATE_LIMIT_UNAVAILABLE",
      error: "Could not verify request limits. Please try again.",
      status: 503,
    });
  }

  if (!rateLimit.ok) {
    return creditErrorJson({
      shopDomain,
      plan,
      code: "RATE_LIMIT_EXCEEDED",
      error: "Keyword suggestion limit reached. Please try again later.",
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    });
  }

  const adminGraphql: AdminGraphql = admin.graphql.bind(admin);

  try {
    const response = await bulkKeywordAction({
      data,
      shopDomain,
      adminGraphql,
      plan,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Keyword suggestion action failed", {
      shopDomain,
      productCount: data.productIds.length,
      error: safeError(error),
    });

    return creditErrorJson({
      shopDomain,
      plan,
      code: "KEYWORD_SUGGESTION_FAILED",
      error: "Could not suggest keywords. Please try again.",
      status: 500,
    });
  }
}
