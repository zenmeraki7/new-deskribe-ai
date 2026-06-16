import { z } from "zod";

export const SERVER_CAPS = Object.freeze({
  MAX_HTML_CHARS_FOR_ANALYSIS: 100_000,
  MAX_SOURCE_CHARS: 150_000,
  MAX_TOKENS_FOR_DIFF: 2_000,
  MAX_KEYWORDS: 30,
  MAX_KEYWORD_CHARS: 64,
  MAX_TOTAL_KEYWORD_CHARS: 600,
  MAX_KEYWORD_MATCHES_PER_DOC: 5_000,

  /**
   * This is intentionally high for queued jobs, but Remix actions should not
   * synchronously apply these products. They should only enqueue.
   */
  MAX_PRODUCTS_PER_JOB: 2_000,

  /**
   * Safer cap for direct interactive UI apply requests.
   */
  MAX_PRODUCTS_PER_INTERACTIVE_APPLY: 100,
} as const);

function boundedString(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must not exceed ${max} characters`);
}

const shopifyProductGidSchema = z
  .string()
  .regex(
    /^gid:\/\/shopify\/Product\/\d+$/,
    "productId must be a valid Shopify Product GID",
  );

const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Diff viewer payload schema
// ---------------------------------------------------------------------------

const keywordSchema = z
  .string()
  .trim()
  .min(1, "Keyword must not be empty")
  .max(
    SERVER_CAPS.MAX_KEYWORD_CHARS,
    `Keyword must not exceed ${SERVER_CAPS.MAX_KEYWORD_CHARS} characters`,
  )
  .regex(/^[\p{L}\p{N}\s\-'.]+$/u, "Keyword contains disallowed characters");

export const diffPayloadSchema = z
  .object({
    htmlForAnalysis: boundedString(
      SERVER_CAPS.MAX_HTML_CHARS_FOR_ANALYSIS,
      "htmlForAnalysis",
    ),

    sourceHtml: boundedString(SERVER_CAPS.MAX_SOURCE_CHARS, "sourceHtml"),

    keywords: z
      .array(keywordSchema)
      .max(
        SERVER_CAPS.MAX_KEYWORDS,
        `No more than ${SERVER_CAPS.MAX_KEYWORDS} keywords`,
      )
      .default([]),

    tokenCount: z
      .number()
      .int()
      .min(0)
      .max(
        SERVER_CAPS.MAX_TOKENS_FOR_DIFF,
        `tokenCount must not exceed ${SERVER_CAPS.MAX_TOKENS_FOR_DIFF}`,
      )
      .optional(),

    keywordMatchesPerDoc: z
      .number()
      .int()
      .min(0)
      .max(
        SERVER_CAPS.MAX_KEYWORD_MATCHES_PER_DOC,
        `keywordMatchesPerDoc must not exceed ${SERVER_CAPS.MAX_KEYWORD_MATCHES_PER_DOC}`,
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const totalKeywordChars = value.keywords.reduce(
      (sum, keyword) => sum + keyword.length,
      0,
    );

    if (totalKeywordChars > SERVER_CAPS.MAX_TOTAL_KEYWORD_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords"],
        message: `Total keyword characters must not exceed ${SERVER_CAPS.MAX_TOTAL_KEYWORD_CHARS}`,
      });
    }
  });

export type DiffPayload = z.infer<typeof diffPayloadSchema>;

// ---------------------------------------------------------------------------
// Safer production apply request
// ---------------------------------------------------------------------------

/**
 * Preferred production schema.
 *
 * This avoids trusting client-submitted generated fields.
 * The action should:
 * 1. validate this payload
 * 2. verify job belongs to current shop
 * 3. fetch sanitized generated outputs from DB
 * 4. create ApplyJob
 * 5. enqueue worker
 */
export const enqueueApplyJobSchema = z
  .object({
    jobId: uuidSchema,
    applyId: uuidSchema,
    productIds: z
      .array(shopifyProductGidSchema)
      .min(1, "At least one product is required")
      .max(
        SERVER_CAPS.MAX_PRODUCTS_PER_JOB,
        `No more than ${SERVER_CAPS.MAX_PRODUCTS_PER_JOB} products per apply job`,
      ),
  })
  .strict();

export type EnqueueApplyJobPayload = z.infer<typeof enqueueApplyJobSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateDiffPayload(raw: unknown): DiffPayload {
  return parseOrThrow(diffPayloadSchema, raw);
}

export function validateEnqueueApplyJob(raw: unknown): EnqueueApplyJobPayload {
  return parseOrThrow(enqueueApplyJobSchema, raw);
}

function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw ServerValidationError.fromZodError(result.error);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export class ServerValidationError extends Error {
  public readonly status: number;
  public readonly issues: ValidationIssue[];

  constructor(status: number, issues: ValidationIssue[]) {
    super("Validation failed");
    this.name = "ServerValidationError";
    this.status = status;
    this.issues = issues;
  }

  static fromZodError(error: z.ZodError): ServerValidationError {
    return new ServerValidationError(
      400,
      error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    );
  }
}

export function isServerValidationError(
  error: unknown,
): error is ServerValidationError {
  return error instanceof ServerValidationError;
}

export function validationErrorResponse(err: ServerValidationError): Response {
  return Response.json(
    {
      ok: false,
      errors: err.issues,
    },
    {
      status: err.status,
    },
  );
}
