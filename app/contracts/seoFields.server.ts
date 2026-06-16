import sanitizeHtml from "sanitize-html";
import { z } from "zod";

import {
  FIELD_LIMITS,
  SEO_FIELD_KEYS,
  assertHasWritableSeoFields,
  normalizeHandle,
  sanitizePlainTextField,
  sanitizeTags,
  truncateText,
  type RawAiSeoFields,
  type SanitizationWarning,
  type SanitizedSeoFields,
  type SanitizedSeoOutput,
  type SeoFieldKey,
} from "./seoFields";

const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

const WARNING_CODES = [
  "DROPPED",
  "TRUNCATED",
  "SANITIZED",
  "INVALID_TYPE",
  "EMPTY_AFTER_SANITIZATION",
  "LIMIT_EXCEEDED",
  "UNSUPPORTED_FIELD",
] as const;

const KNOWN_FIELD_KEYS = new Set<string>(SEO_FIELD_KEYS);

function warning(
  field: SeoFieldKey,
  code: SanitizationWarning["code"],
  message: string,
): SanitizationWarning {
  return { field, code, message };
}

function hasOwnField(
  fields: Record<string, unknown>,
  key: keyof RawAiSeoFields,
): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

export const SanitizationWarningSchema = z
  .object({
    field: z.enum([
      "title",
      "descriptionHtml",
      "seoTitle",
      "seoDescription",
      "handle",
      "tags",
      "metafieldValue",
    ]),
    code: z.enum(WARNING_CODES),
    message: z.string().min(1).max(500),
  })
  .strict();

export const RawAiSeoFieldsSchema = z
  .object({
    title: z.unknown().optional(),
    descriptionHtml: z.unknown().optional(),
    seoTitle: z.unknown().optional(),
    seoDescription: z.unknown().optional(),
    handle: z.unknown().optional(),
    tags: z.unknown().optional(),
    metafieldValue: z.unknown().optional(),
  })
  .passthrough();

export const RawAiSeoOutputSchema = z
  .object({
    shopId: z.string().min(1).max(255),
    productId: z.string().regex(PRODUCT_GID_RE),
    fields: RawAiSeoFieldsSchema,
  })
  .strict();

export const SanitizedSeoFieldsSchema = z
  .object({
    title: z.string().min(1).max(FIELD_LIMITS.TITLE_CHARS).optional(),
    descriptionHtml: z
      .string()
      .min(1)
      .max(FIELD_LIMITS.DESCRIPTION_HTML_CHARS)
      .optional(),
    seoTitle: z.string().min(1).max(FIELD_LIMITS.SEO_TITLE_CHARS).optional(),
    seoDescription: z
      .string()
      .min(1)
      .max(FIELD_LIMITS.SEO_DESCRIPTION_CHARS)
      .optional(),
    handle: z.string().min(1).max(FIELD_LIMITS.HANDLE_CHARS).optional(),
    tags: z
      .array(z.string().min(1).max(FIELD_LIMITS.TAG_CHARS))
      .max(FIELD_LIMITS.TAGS_PER_PRODUCT)
      .optional(),
    metafieldValue: z
      .string()
      .min(1)
      .max(FIELD_LIMITS.METAFIELD_TEXT_CHARS)
      .optional(),
  })
  .strict();

export const SanitizedSeoOutputSchema = z
  .object({
    shopId: z.string().min(1).max(255),
    productId: z.string().regex(PRODUCT_GID_RE),
    fields: SanitizedSeoFieldsSchema,
    warnings: z.array(SanitizationWarningSchema).max(100),
  })
  .strict();

export const SeoApplyPayloadSchema = z
  .object({
    shopId: z.string().min(1).max(255),
    shopDomain: z.string().regex(SHOP_DOMAIN_RE),
    jobId: z.string().uuid(),
    applyId: z.string().uuid(),
    productId: z.string().regex(PRODUCT_GID_RE),
    fields: SanitizedSeoFieldsSchema.refine(
      (fields) => Object.keys(fields).length > 0,
      "At least one SEO field must be present.",
    ),
  })
  .strict();

export const ProductSeoSnapshotSchema = z
  .object({
    shopId: z.string().min(1).max(255),
    shopDomain: z.string().regex(SHOP_DOMAIN_RE),
    productId: z.string().regex(PRODUCT_GID_RE),
    jobId: z.string().uuid(),
    applyId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    fields: SanitizedSeoFieldsSchema,
  })
  .strict();

export type RawAiSeoOutputInput = z.infer<typeof RawAiSeoOutputSchema>;
export type SeoApplyPayloadInput = z.infer<typeof SeoApplyPayloadSchema>;
export type ProductSeoSnapshotInput = z.infer<typeof ProductSeoSnapshotSchema>;

export function sanitizeDescriptionHtmlServer(value: unknown): {
  value?: string;
  warnings: SanitizationWarning[];
} {
  const warnings: SanitizationWarning[] = [];

  if (typeof value !== "string") {
    warnings.push(
      warning(
        "descriptionHtml",
        "INVALID_TYPE",
        "descriptionHtml must be a string.",
      ),
    );
    return { warnings };
  }

  const trimmed = value.trim();
  const cleaned = sanitizeHtml(trimmed, {
    allowedTags: ["p", "br", "ul", "ol", "li", "strong", "b", "em", "i"],
    allowedAttributes: {},
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
  });

  if (cleaned !== trimmed) {
    warnings.push(
      warning(
        "descriptionHtml",
        "SANITIZED",
        "Unsafe or unsupported HTML was removed from descriptionHtml.",
      ),
    );
  }

  const truncated = truncateText(
    cleaned,
    FIELD_LIMITS.DESCRIPTION_HTML_CHARS,
  );

  if (truncated.truncated) {
    warnings.push(
      warning(
        "descriptionHtml",
        "TRUNCATED",
        `descriptionHtml exceeded ${FIELD_LIMITS.DESCRIPTION_HTML_CHARS} characters and was truncated.`,
      ),
    );
  }

  if (!truncated.value) {
    warnings.push(
      warning(
        "descriptionHtml",
        "EMPTY_AFTER_SANITIZATION",
        "descriptionHtml was empty after sanitization.",
      ),
    );
    return { warnings };
  }

  return {
    value: truncated.value,
    warnings,
  };
}

export function sanitizeRawAiSeoOutputServer(
  input: unknown,
): SanitizedSeoOutput {
  const parsed = RawAiSeoOutputSchema.parse(input);
  const rawFields = parsed.fields as Record<string, unknown>;
  const fields: Partial<SanitizedSeoFields> = {};
  const warnings: SanitizationWarning[] = [];

  for (const key of Object.keys(rawFields)) {
    if (!KNOWN_FIELD_KEYS.has(key)) {
      warnings.push(
        warning(
          "metafieldValue",
          "UNSUPPORTED_FIELD",
          `Unsupported SEO field "${key}" was ignored.`,
        ),
      );
    }
  }

  if (hasOwnField(rawFields, "title")) {
    const result = sanitizePlainTextField(
      "title",
      rawFields.title,
      FIELD_LIMITS.TITLE_CHARS,
    );
    if (result.value) fields.title = result.value;
    warnings.push(...result.warnings);
  }

  if (hasOwnField(rawFields, "descriptionHtml")) {
    const result = sanitizeDescriptionHtmlServer(rawFields.descriptionHtml);
    if (result.value) fields.descriptionHtml = result.value;
    warnings.push(...result.warnings);
  }

  if (hasOwnField(rawFields, "seoTitle")) {
    const result = sanitizePlainTextField(
      "seoTitle",
      rawFields.seoTitle,
      FIELD_LIMITS.SEO_TITLE_CHARS,
    );
    if (result.value) fields.seoTitle = result.value;
    warnings.push(...result.warnings);
  }

  if (hasOwnField(rawFields, "seoDescription")) {
    const result = sanitizePlainTextField(
      "seoDescription",
      rawFields.seoDescription,
      FIELD_LIMITS.SEO_DESCRIPTION_CHARS,
    );
    if (result.value) fields.seoDescription = result.value;
    warnings.push(...result.warnings);
  }

  if (hasOwnField(rawFields, "handle")) {
    if (typeof rawFields.handle !== "string") {
      warnings.push(warning("handle", "INVALID_TYPE", "handle must be a string."));
    } else {
      const normalized = normalizeHandle(rawFields.handle);
      if (!normalized) {
        warnings.push(
          warning(
            "handle",
            "EMPTY_AFTER_SANITIZATION",
            "handle was empty after sanitization.",
          ),
        );
      } else {
        if (normalized !== rawFields.handle) {
          warnings.push(
            warning(
              "handle",
              "SANITIZED",
              "handle was normalized into a safe Shopify URL slug.",
            ),
          );
        }
        fields.handle = normalized;
      }
    }
  }

  if (hasOwnField(rawFields, "tags")) {
    const result = sanitizeTags(rawFields.tags);
    if (result.value) fields.tags = result.value;
    warnings.push(...result.warnings);
  }

  if (hasOwnField(rawFields, "metafieldValue")) {
    const result = sanitizePlainTextField(
      "metafieldValue",
      rawFields.metafieldValue,
      FIELD_LIMITS.METAFIELD_TEXT_CHARS,
    );
    if (result.value) fields.metafieldValue = result.value;
    warnings.push(...result.warnings);
  }

  const output = SanitizedSeoOutputSchema.parse({
    shopId: parsed.shopId,
    productId: parsed.productId,
    fields,
    warnings,
  });

  return output;
}

export function sanitizeWritableRawAiSeoOutput(input: unknown): SanitizedSeoOutput {
  const output = sanitizeRawAiSeoOutputServer(input);
  assertHasWritableSeoFields(output);
  return output;
}

export const sanitizeAiOutput = sanitizeWritableRawAiSeoOutput;
