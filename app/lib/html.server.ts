// FILE: app/lib/html.server.ts

import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "a",
  "img",
];

const ALLOWED_ATTR = {
  a: ["href", "target", "rel"],
  img: ["src", "alt"],
};

export function sanitiseHtml(input: string): string {
  if (typeof input !== "string") return "";

  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTR,
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer",
        target: "_blank",
      }),
    },
    disallowedTagsMode: "discard",
  });
}

// Safe plain-text extractor (no regex sanitizer)
export function stripHtml(input: string): string {
  if (typeof input !== "string") return "";
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}
