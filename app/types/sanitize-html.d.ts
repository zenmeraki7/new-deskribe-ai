declare module "sanitize-html" {
  interface SanitizeHtmlOptions {
    allowedTags?: string[] | false;
    allowedAttributes?: Record<string, string[]> | false;
    allowedSchemes?: string[];
    transformTags?: Record<string, unknown>;
    disallowedTagsMode?: "discard" | "escape" | "recursiveEscape";
    enforceHtmlBoundary?: boolean;
  }

  interface SanitizeHtml {
    (dirty: string, options?: SanitizeHtmlOptions): string;
    simpleTransform(
      tagName: string,
      attribs?: Record<string, string>,
      merge?: boolean,
    ): unknown;
  }

  const sanitizeHtml: SanitizeHtml;
  export default sanitizeHtml;
}
