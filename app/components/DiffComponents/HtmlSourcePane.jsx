// FILE: app/components/diffViewer/HtmlSourcePane.jsx
import React, { useCallback, useMemo, useRef, useState } from "react";
import { BlockStack, InlineStack, Text, Button, Banner } from "@shopify/polaris";
import { LIMITS, clampSourceHtml } from "./limits";
import { buildKeywordRegex, normalizeKeywords } from "./keywords";

/**
 * HtmlSourcePane (read-only display)
 *
 * Security + performance contract:
 * - Display-only; NEVER used for persistence.
 * - Treat HTML as untrusted; do not execute; render as text only.
 * - Bound work: cap source size and highlight operations.
 * - Avoid regex-based HTML parsing; only use safe splitting for *coloring* presentation.
 */

function safeClipboardWrite(text) {
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
 * Note: This is not parsing/sanitizing; it’s a best-effort tokenizer for display.
 * Pattern is linear and bounded by MAX_SOURCE_CHARS.
 */
function splitHtmlForColoring(html) {
  return String(html ?? "").split(/(<[^>]+>)/g);
}

function capParts(parts, cap) {
  if (!Array.isArray(parts)) return [];
  if (parts.length <= cap) return parts;
  return [
    ...parts.slice(0, Math.floor(cap / 2)),
    "\n<!-- [Source truncated for performance] -->\n",
    ...parts.slice(-Math.floor(cap / 2)),
  ];
}

export function HtmlSourcePane({ html, keywords }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const timerRef = useRef(null);

  const safeHtml = useMemo(() => clampSourceHtml(html ?? ""), [html]);
  const wasTruncated = useMemo(() => typeof html === "string" && html.length > safeHtml.length, [html, safeHtml]);

  const safeKeywords = useMemo(() => normalizeKeywords(keywords), [keywords]);
  const re = useMemo(() => buildKeywordRegex(safeKeywords), [safeKeywords]);

  // Bound split output to avoid rendering enormous arrays of spans.
  const chunks = useMemo(() => {
    const parts = splitHtmlForColoring(safeHtml);
    // Arbitrary but safe: prevent pathological tag tokenization from freezing React.
    return capParts(parts, 12_000);
  }, [safeHtml]);

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

  // Cap highlighting work per text chunk to keep rendering predictable.
  const HIGHLIGHT_CHUNK_CHAR_CAP = 20_000;

  return (
    <BlockStack gap="200">
      {(wasTruncated || copyError) && (
        <Banner tone={copyError ? "critical" : "warning"}>
          <p>{copyError ? copyError : "HTML source has been truncated for safe preview."}</p>
        </Banner>
      )}

      <InlineStack align="space-between" blockAlign="center">
        <Text variant="bodySm" tone="subdued">
          HTML Source (Read-only)
        </Text>
        <Button size="micro" onClick={handleCopy} disabled={!safeHtml}>
          {copied ? "✓ Copied" : "Copy"}
        </Button>
      </InlineStack>

      <div
        style={{
          background: "#202124",
          color: "#e8eaed",
          padding: "12px",
          borderRadius: "6px",
          fontFamily: "var(--p-font-family-mono)",
          fontSize: "12px",
          maxHeight: "400px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
        aria-label="HTML source viewer"
      >
        {chunks.map((chunk, i) => {
          if (typeof chunk !== "string" || !chunk) return null;

          // Tags get colored, but not highlighted (keywords inside tags isn't useful and costs work).
          if (chunk.startsWith("<")) {
            const isClosing = chunk.startsWith("</");
            return (
              <span key={i} style={{ color: isClosing ? "#8ab4f8" : "#c58af9" }}>
                {chunk}
              </span>
            );
          }

          // Text chunks: optional keyword highlight, but bounded.
          if (!re || !chunk.trim()) return <span key={i}>{chunk}</span>;

          const workChunk =
            chunk.length <= HIGHLIGHT_CHUNK_CHAR_CAP
              ? chunk
              : `${chunk.slice(0, HIGHLIGHT_CHUNK_CHAR_CAP)}\n<!-- [text chunk truncated] -->\n`;

          re.lastIndex = 0;
          const parts = workChunk.split(re);
          if (parts.length <= 1) return <span key={i}>{workChunk}</span>;

          // Additional cap on parts to avoid enormous mark/span counts.
          const PARTS_CAP = 4000;
          const safeParts = parts.length <= PARTS_CAP ? parts : parts.slice(0, PARTS_CAP).concat(["…"]);

          return safeParts.map((p, j) => {
            const isMatch = j % 2 === 1;
            return isMatch ? (
              <mark
                key={`${i}-${j}`}
                style={{
                  background: "#f9e2af",
                  color: "#202124",
                  borderRadius: 2,
                  padding: "0 2px",
                  fontWeight: 700,
                }}
              >
                {p}
              </mark>
            ) : (
              <span key={`${i}-${j}`}>{p}</span>
            );
          });
        })}

        {!safeHtml && <span>&lt;!-- No content --&gt;</span>}
      </div>

      {/* Small explicit note to discourage "copy/paste to save" flows */}
      <Text variant="bodySm" tone="subdued">
        Tip: This view is for debugging only. Saving/applying must use server-owned versions/jobs (not pasted HTML).
      </Text>
    </BlockStack>
  );
}
