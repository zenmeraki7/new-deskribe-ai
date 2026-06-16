// FILE: app/components/diffViewer/HtmlSourcePane.tsx
import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Banner, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { clampSourceHtml } from "./limits";
import { buildKeywordRegexFromNormalized, normalizeKeywords } from "./keywords";

// MAX_PARTS: total HTML split chunks (tags + text) fed into the part builder.
// HIGHLIGHT_CHUNK_CHAR_CAP: max characters processed per text chunk for highlighting.
// HIGHLIGHT_PARTS_CAP: max keyword-split parts per text chunk.
// Combined worst case: MAX_PARTS chunks x HIGHLIGHT_PARTS_CAP parts each.
// In practice HIGHLIGHT_CHUNK_CHAR_CAP limits real output well below that.
const MAX_PARTS = 2_000;
const HIGHLIGHT_CHUNK_CHAR_CAP = 20_000;
const HIGHLIGHT_PARTS_CAP = 4_000;

type SourcePartKind = "openingTag" | "closingTag" | "mark" | "text";

type SourcePart = {
  kind: SourcePartKind;
  text: string;
};

type HtmlSourcePaneProps = {
  html?: unknown;
  keywords?: unknown;
};

const viewerStyle: CSSProperties = {
  background: "var(--p-color-bg-surface-inverse, #202124)",
  color: "var(--p-color-text-inverse, #e8eaed)",
  padding: "12px",
  borderRadius: "6px",
  fontFamily: "var(--p-font-family-mono)",
  fontSize: "12px",
  maxHeight: "400px",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  border: "1px solid var(--p-color-border-inverse, rgba(255,255,255,0.08))",
};

// Syntax colors intentionally use fixed readable hues on the inverse source background.
const openingTagStyle: CSSProperties = { color: "#c58af9" };
const closingTagStyle: CSSProperties = { color: "#8ab4f8" };

// Keyword marks need high contrast against both tag and text source coloring.
const markStyle: CSSProperties = {
  background: "#f9e2af",
  color: "#202124",
  borderRadius: 2,
  padding: "0 2px",
  fontWeight: 700,
};

/**
 * HtmlSourcePane (read-only display)
 *
 * Security + performance contract:
 * - Display-only; NEVER used for persistence.
 * - Treat HTML as untrusted; do not execute; render as text only.
 * - Bound work: cap source size and highlight operations.
 * - Avoid regex-based HTML parsing; only use safe splitting for *coloring* presentation.
 */

function safeClipboardWrite(text: string) {
  try {
    if (typeof navigator === "undefined") return Promise.reject(new Error("no navigator"));
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      return Promise.reject(new Error("clipboard unavailable"));
    }
    return navigator.clipboard.writeText(text);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Split HTML into tag tokens and text tokens for colorized *source* rendering.
 * Note: This is not parsing/sanitizing; it is a best-effort tokenizer for display.
 * Known limitation: `>` inside quoted attributes can split oddly, but this view is display-only.
 * Pattern is linear and bounded by MAX_SOURCE_CHARS.
 */
function splitHtmlForColoring(html: unknown): string[] {
  return String(html ?? "").split(/(<[^>]+>)/g);
}

function capParts(parts: unknown, cap: number): string[] {
  if (!Array.isArray(parts)) return [];
  if (parts.length <= cap) return parts;
  return [
    ...parts.slice(0, Math.floor(cap / 2)),
    "\n<!-- [Source truncated for performance] -->\n",
    ...parts.slice(-Math.floor(cap / 2)),
  ];
}

function partKey(part: SourcePart, index: number) {
  return `${part.kind}:${index}:${part.text.slice(0, 12)}`;
}

function buildSourceParts({
  chunks,
  re,
}: {
  chunks: string[];
  re: RegExp | null;
}): SourcePart[] {
  const sourceParts: SourcePart[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (typeof chunk !== "string" || !chunk) continue;

    if (chunk.startsWith("<")) {
      sourceParts.push({
        kind: chunk.startsWith("</") ? "closingTag" : "openingTag",
        text: chunk,
      });
      continue;
    }

    if (!re || !chunk.trim()) {
      sourceParts.push({ kind: "text", text: chunk });
      continue;
    }

    const workChunk =
      chunk.length <= HIGHLIGHT_CHUNK_CHAR_CAP
        ? chunk
        : `${chunk.slice(0, HIGHLIGHT_CHUNK_CHAR_CAP)}\n<!-- [text chunk truncated] -->\n`;

    re.lastIndex = 0;
    const parts = workChunk.split(re);
    if (parts.length <= 1) {
      sourceParts.push({ kind: "text", text: workChunk });
      continue;
    }

    const safeParts: string[] =
      parts.length <= HIGHLIGHT_PARTS_CAP
        ? parts
        : parts.slice(0, HIGHLIGHT_PARTS_CAP).concat(["..."]);

    for (let j = 0; j < safeParts.length; j++) {
      sourceParts.push({
        kind: j % 2 === 1 ? "mark" : "text",
        text: safeParts[j],
      });
    }
  }

  return sourceParts;
}

export function HtmlSourcePane({ html, keywords }: HtmlSourcePaneProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const safeHtml = useMemo(() => clampSourceHtml(html ?? ""), [html]);
  const wasTruncated = useMemo(
    () => typeof html === "string" && html.length > safeHtml.length,
    [html, safeHtml],
  );

  const safeKeywords = useMemo(() => normalizeKeywords(keywords), [keywords]);
  const re = useMemo(
    () => buildKeywordRegexFromNormalized(safeKeywords),
    [safeKeywords],
  );

  useEffect(() => {
    setCopyError("");
    setCopied(false);
  }, [html]);

  const chunks = useMemo(() => {
    const parts = splitHtmlForColoring(safeHtml);
    return capParts(parts, MAX_PARTS);
  }, [safeHtml]);

  const sourceParts = useMemo(() => buildSourceParts({ chunks, re }), [chunks, re]);

  const handleCopy = useCallback(() => {
    setCopyError("");
    if (!safeHtml) return;

    safeClipboardWrite(safeHtml)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        setCopied(false);
        setCopyError("Copy failed. Your browser may block clipboard access in this context.");
      });
  }, [safeHtml]);

  return (
    <BlockStack gap="200">
      {wasTruncated && (
        <Banner tone="warning">
          <p>HTML source has been truncated for safe preview.</p>
        </Banner>
      )}

      {copyError && (
        <Banner tone="critical">
          <p>{copyError}</p>
        </Banner>
      )}

      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" variant="bodySm" tone="subdued">
          HTML Source (Read-only)
        </Text>
        <Button size="micro" onClick={handleCopy} disabled={!safeHtml}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </InlineStack>

      <div style={viewerStyle} aria-label="HTML source viewer">
        {sourceParts.map((part, index) => {
          if (part.kind === "openingTag") {
            return (
              <span key={partKey(part, index)} style={openingTagStyle}>
                {part.text}
              </span>
            );
          }

          if (part.kind === "closingTag") {
            return (
              <span key={partKey(part, index)} style={closingTagStyle}>
                {part.text}
              </span>
            );
          }

          if (part.kind === "mark") {
            return (
              <mark key={partKey(part, index)} style={markStyle}>
                {part.text}
              </mark>
            );
          }

          return <span key={partKey(part, index)}>{part.text}</span>;
        })}

        {!safeHtml && <span>&lt;!-- No content --&gt;</span>}
      </div>

      <Text as="p" variant="bodySm" tone="subdued">
        Tip: This view is for debugging only. Saving/applying must use server-owned versions/jobs (not pasted HTML).
      </Text>
    </BlockStack>
  );
}
