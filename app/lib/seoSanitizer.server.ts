import DOMPurify from "isomorphic-dompurify";

import { SanitizedSeoFieldsSchema } from "../contracts/seoFields.server";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "a",
];

const ALLOWED_ATTR = ["href", "target", "rel"];

export function parseAndResanitizeSeoFields(fields: unknown) {
  const parsed = SanitizedSeoFieldsSchema.parse(fields);

  return {
    ...parsed,
    descriptionHtml:
      typeof parsed.descriptionHtml === "string"
        ? DOMPurify.sanitize(parsed.descriptionHtml, {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
            FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
            FORBID_ATTR: ["onerror", "onclick", "onload", "style"],
          })
        : parsed.descriptionHtml,
  };
}
