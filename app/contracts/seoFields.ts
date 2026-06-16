/**
 * Canonical SEO field shapes, app-enforced limits, sanitizer contracts,
 * and snapshot contracts for bulk Shopify SEO generation.
 *
 * Import this in:
 * - server validation schemas
 * - AI output sanitization
 * - Remix actions
 * - job workers
 * - UI preview components
 * - Shopify write-back logic
 *
 * Important:
 * These are APP-SAFE limits, not necessarily Shopify's absolute internal max.
 * Do not widen without updating:
 * - Zod schemas
 * - sanitizer
 * - AI prompt constraints
 * - DB column sizing
 * - tests
 */

export const FIELD_LIMITS = Object.freeze({
  /**
   * productUpdate.title
   * Shopify product title can be longer, but 255 is a safe production cap.
   */
  TITLE_CHARS: 255,

  /**
   * productUpdate.descriptionHtml
   * Keep this lower than raw Shopify capacity to protect:
   * - preview rendering
   * - diffing
   * - sanitizer cost
   * - AI prompt/output size
   * - Admin INP/hydration
   */
  DESCRIPTION_HTML_CHARS: 30_000,

  /**
   * product.seo.title
   * App-enforced SEO recommendation cap.
   */
  SEO_TITLE_CHARS: 70,

  /**
   * product.seo.description
   * App-enforced SEO recommendation cap.
   */
  SEO_DESCRIPTION_CHARS: 320,

  /**
   * product.handle
   * URL slug. Must be normalized before write-back.
   */
  HANDLE_CHARS: 255,

  /**
   * Single product tag.
   */
  TAG_CHARS: 255,

  /**
   * Total tags per product.
   */
  TAGS_PER_PRODUCT: 250,

  /**
   * Generic text metafield app-safe cap.
   * Actual Shopify metafield limits depend on metafield type.
   */
  METAFIELD_TEXT_CHARS: 65_535,
} as const);

export type SeoFieldKey =
  | "title"
  | "descriptionHtml"
  | "seoTitle"
  | "seoDescription"
  | "handle"
  | "tags"
  | "metafieldValue";

export const SEO_FIELD_KEYS: readonly SeoFieldKey[] = Object.freeze([
  "title",
  "descriptionHtml",
  "seoTitle",
  "seoDescription",
  "handle",
  "tags",
  "metafieldValue",
]);

export type SanitizationWarningCode =
  | "DROPPED"
  | "TRUNCATED"
  | "SANITIZED"
  | "INVALID_TYPE"
  | "EMPTY_AFTER_SANITIZATION"
  | "LIMIT_EXCEEDED"
  | "UNSUPPORTED_FIELD";

export interface SanitizationWarning {
  field: SeoFieldKey;
  code: SanitizationWarningCode;
  message: string;
}

export interface RawAiSeoFields {
  title?: string;
  descriptionHtml?: string;
  seoTitle?: string;
  seoDescription?: string;
  handle?: string;
  tags?: string[];
  metafieldValue?: string;
}

export interface SanitizedSeoFields {
  title?: string;
  descriptionHtml?: string;
  seoTitle?: string;
  seoDescription?: string;
  handle?: string;
  tags?: string[];
  metafieldValue?: string;
}

export interface RawAiSeoOutput {
  shopId: string;
  productId: string;
  fields: Partial<RawAiSeoFields>;
}

export interface SanitizedSeoOutput {
  shopId: string;
  productId: string;
  fields: Partial<SanitizedSeoFields>;
  warnings: SanitizationWarning[];
}

export interface ProductSeoSnapshot {
  shopId: string;
  shopDomain: string;
  productId: string;
  jobId: string;
  applyId: string;
  capturedAt: string;
  fields: Partial<SanitizedSeoFields>;
}

export interface SeoApplyPayload {
  shopId: string;
  shopDomain: string;
  jobId: string;
  applyId: string;
  productId: string;
  fields: Partial<SanitizedSeoFields>;
}

export function isSeoFieldKey(value: unknown): value is SeoFieldKey {
  return (
    typeof value === "string" && SEO_FIELD_KEYS.includes(value as SeoFieldKey)
  );
}

export function truncateText(
  value: string,
  maxChars: number,
): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return {
    value: value.slice(0, maxChars),
    truncated: true,
  };
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeHandle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FIELD_LIMITS.HANDLE_CHARS);
}

export function sanitizePlainTextField(
  field: Exclude<SeoFieldKey, "descriptionHtml" | "tags">,
  value: unknown,
  maxChars: number,
): {
  value?: string;
  warnings: SanitizationWarning[];
} {
  const warnings: SanitizationWarning[] = [];

  if (typeof value !== "string") {
    warnings.push({
      field,
      code: "INVALID_TYPE",
      message: `${field} must be a string.`,
    });

    return { warnings };
  }

  const cleaned = normalizeWhitespace(value);

  if (!cleaned) {
    warnings.push({
      field,
      code: "EMPTY_AFTER_SANITIZATION",
      message: `${field} was empty after sanitization.`,
    });

    return { warnings };
  }

  const truncated = truncateText(cleaned, maxChars);

  if (truncated.truncated) {
    warnings.push({
      field,
      code: "TRUNCATED",
      message: `${field} exceeded ${maxChars} characters and was truncated.`,
    });
  }

  return {
    value: truncated.value,
    warnings,
  };
}

export function sanitizeTags(value: unknown): {
  value?: string[];
  warnings: SanitizationWarning[];
} {
  const warnings: SanitizationWarning[] = [];

  if (!Array.isArray(value)) {
    warnings.push({
      field: "tags",
      code: "INVALID_TYPE",
      message: "tags must be an array of strings.",
    });

    return { warnings };
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      warnings.push({
        field: "tags",
        code: "INVALID_TYPE",
        message: "Dropped non-string tag.",
      });
      continue;
    }

    const cleaned = normalizeWhitespace(item);

    if (!cleaned) continue;

    const truncated = truncateText(cleaned, FIELD_LIMITS.TAG_CHARS);

    if (truncated.truncated) {
      warnings.push({
        field: "tags",
        code: "TRUNCATED",
        message: `Tag exceeded ${FIELD_LIMITS.TAG_CHARS} characters and was truncated.`,
      });
    }

    const dedupeKey = truncated.value.toLowerCase();

    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      tags.push(truncated.value);
    }

    if (tags.length >= FIELD_LIMITS.TAGS_PER_PRODUCT) {
      warnings.push({
        field: "tags",
        code: "LIMIT_EXCEEDED",
        message: `Only ${FIELD_LIMITS.TAGS_PER_PRODUCT} tags are allowed per product.`,
      });
      break;
    }
  }

  return {
    value: tags,
    warnings,
  };
}

/**
 * Minimal HTML sanitizer guard.
 *
 * For production, use a real server-side sanitizer such as sanitize-html
 * with an allowlist. This function is intentionally conservative and should
 * be replaced or wrapped by your server sanitizer.
 */
export function sanitizeDescriptionHtml(value: unknown): {
  value?: string;
  warnings: SanitizationWarning[];
} {
  const warnings: SanitizationWarning[] = [];

  if (typeof value !== "string") {
    warnings.push({
      field: "descriptionHtml",
      code: "INVALID_TYPE",
      message: "descriptionHtml must be a string.",
    });

    return { warnings };
  }

  let cleaned = value.trim();

  cleaned = cleaned
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");

  if (cleaned !== value.trim()) {
    warnings.push({
      field: "descriptionHtml",
      code: "SANITIZED",
      message: "Unsafe HTML patterns were removed from descriptionHtml.",
    });
  }

  const truncated = truncateText(cleaned, FIELD_LIMITS.DESCRIPTION_HTML_CHARS);

  if (truncated.truncated) {
    warnings.push({
      field: "descriptionHtml",
      code: "TRUNCATED",
      message: `descriptionHtml exceeded ${FIELD_LIMITS.DESCRIPTION_HTML_CHARS} characters and was truncated.`,
    });
  }

  if (!truncated.value) {
    warnings.push({
      field: "descriptionHtml",
      code: "EMPTY_AFTER_SANITIZATION",
      message: "descriptionHtml was empty after sanitization.",
    });

    return { warnings };
  }

  return {
    value: truncated.value,
    warnings,
  };
}

export function sanitizeRawAiSeoOutput(
  input: RawAiSeoOutput,
): SanitizedSeoOutput {
  const fields: Partial<SanitizedSeoFields> = {};
  const warnings: SanitizationWarning[] = [];

  if (input.fields.title !== undefined) {
    const result = sanitizePlainTextField(
      "title",
      input.fields.title,
      FIELD_LIMITS.TITLE_CHARS,
    );

    if (result.value) fields.title = result.value;
    warnings.push(...result.warnings);
  }

  if (input.fields.descriptionHtml !== undefined) {
    const result = sanitizeDescriptionHtml(input.fields.descriptionHtml);

    if (result.value) fields.descriptionHtml = result.value;
    warnings.push(...result.warnings);
  }

  if (input.fields.seoTitle !== undefined) {
    const result = sanitizePlainTextField(
      "seoTitle",
      input.fields.seoTitle,
      FIELD_LIMITS.SEO_TITLE_CHARS,
    );

    if (result.value) fields.seoTitle = result.value;
    warnings.push(...result.warnings);
  }

  if (input.fields.seoDescription !== undefined) {
    const result = sanitizePlainTextField(
      "seoDescription",
      input.fields.seoDescription,
      FIELD_LIMITS.SEO_DESCRIPTION_CHARS,
    );

    if (result.value) fields.seoDescription = result.value;
    warnings.push(...result.warnings);
  }

  if (input.fields.handle !== undefined) {
    if (typeof input.fields.handle !== "string") {
      warnings.push({
        field: "handle",
        code: "INVALID_TYPE",
        message: "handle must be a string.",
      });
    } else {
      const normalized = normalizeHandle(input.fields.handle);

      if (!normalized) {
        warnings.push({
          field: "handle",
          code: "EMPTY_AFTER_SANITIZATION",
          message: "handle was empty after sanitization.",
        });
      } else {
        if (normalized !== input.fields.handle) {
          warnings.push({
            field: "handle",
            code: "SANITIZED",
            message: "handle was normalized into a safe Shopify URL slug.",
          });
        }

        fields.handle = normalized;
      }
    }
  }

  if (input.fields.tags !== undefined) {
    const result = sanitizeTags(input.fields.tags);

    if (result.value) fields.tags = result.value;
    warnings.push(...result.warnings);
  }

  if (input.fields.metafieldValue !== undefined) {
    const result = sanitizePlainTextField(
      "metafieldValue",
      input.fields.metafieldValue,
      FIELD_LIMITS.METAFIELD_TEXT_CHARS,
    );

    if (result.value) fields.metafieldValue = result.value;
    warnings.push(...result.warnings);
  }

  return {
    shopId: input.shopId,
    productId: input.productId,
    fields,
    warnings,
  };
}

export function assertHasWritableSeoFields(
  output: SanitizedSeoOutput,
): asserts output is SanitizedSeoOutput & {
  fields: Partial<SanitizedSeoFields>;
} {
  if (Object.keys(output.fields).length === 0) {
    throw new Error(
      `Sanitized SEO output for product ${output.productId} has no writable fields.`,
    );
  }
}

export function createProductSeoSnapshot(args: {
  shopId: string;
  shopDomain: string;
  productId: string;
  jobId: string;
  applyId: string;
  fields: Partial<SanitizedSeoFields>;
  capturedAt?: string;
}): ProductSeoSnapshot {
  return {
    shopId: args.shopId,
    shopDomain: args.shopDomain,
    productId: args.productId,
    jobId: args.jobId,
    applyId: args.applyId,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    fields: args.fields,
  };
}
