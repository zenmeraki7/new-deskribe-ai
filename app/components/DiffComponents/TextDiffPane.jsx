// FILE: app/components/diffViewer/TextDiffPane.jsx
import React, { useMemo } from "react";
import { BlockStack, InlineStack, Badge, Box, Text } from "@shopify/polaris";
import { extractTextForAnalysis, tokenizeForDiff } from "./textAnalysis";
import { buildDiff } from "./diffEngine";
import { normalizeKeywords } from "./keywords";
import { LIMITS } from "./limits";

/**
 * TextDiffPane (UI-side diff)
 *
 * Security + performance contract:
 * - Display-only; never used for persistence or sanitization.
 * - Must stay bounded: extraction + tokenization capped; diff engine capped.
 * - Keyword highlighting uses normalized keyword set; avoid expensive per-token work.
 */

function makeKeywordSet(keywords) {
  const safe = normalizeKeywords(keywords);
  const set = new Set();
  for (const k of safe) set.add(k.toLowerCase());
  return set;
}

export function TextDiffPane({ beforeHtml, afterHtml, keywords }) {
  const keywordSet = useMemo(() => makeKeywordSet(keywords), [keywords]);

  const tokens = useMemo(() => {
    // Extract text (clamped internally) and keep diff input bounded.
    // tokenizeForDiff enforces MAX_TOKENS_FOR_DIFF at the source, but buildDiff also caps.
    const bText = extractTextForAnalysis(beforeHtml);
    const aText = extractTextForAnalysis(afterHtml);

    // Optional: ensure token bounds for very long text even if extraction returns huge content.
    // This is conservative and avoids rare cases where textContent is large while HTML is small.
    const bTok = tokenizeForDiff(bText).join("");
    const aTok = tokenizeForDiff(aText).join("");

    return buildDiff(bTok, aTok);
  }, [beforeHtml, afterHtml]);

  const { added, removed } = useMemo(() => {
    // Count non-whitespace insert/delete segments (coalesced in diffEngine).
    let a = 0;
    let r = 0;

    for (const t of tokens) {
      if (!t || typeof t.text !== "string") continue;
      if (!t.text.trim()) continue;
      if (t.type === "insert") a++;
      else if (t.type === "delete") r++;
    }

    return { added: a, removed: r };
  }, [tokens]);

  // Prevent rendering a huge number of spans (React perf guardrail).
  // diffEngine coalesces, but we still cap.
  const renderTokens = useMemo(() => {
    if (!Array.isArray(tokens)) return [];
    if (tokens.length <= 8000) return tokens;
    // Fail closed: show a truncated diff rather than freezing the UI.
    return [
      ...tokens.slice(0, 4000),
      { text: "\n\n--- [Diff truncated for performance] ---\n\n", type: "equal" },
      ...tokens.slice(-4000),
    ];
  }, [tokens]);

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center">
        <Badge tone="success">+{added} chunks</Badge>
        <Badge tone="critical">-{removed} chunks</Badge>
        <Text as="span" tone="subdued" variant="bodySm">
          (Diff is bounded to {LIMITS.MAX_TOKENS_FOR_DIFF} tokens)
        </Text>
      </InlineStack>

      <Box
        as="div"
        padding="400"
        background="bg-surface-secondary"
        borderRadius="200"
        style={{
          fontFamily: "var(--p-font-family-mono)",
          fontSize: "13px",
          lineHeight: "1.8",
          whiteSpace: "pre-wrap",
          maxHeight: "500px",
          overflowY: "auto",
        }}
      >
        {renderTokens.map((t, i) => {
          const raw = typeof t.text === "string" ? t.text : "";
          const trimmed = raw.trim();
          const isKw = trimmed ? keywordSet.has(trimmed.toLowerCase()) : false;

          if (t.type === "equal") {
            return (
              <span
                key={i}
                style={
                  isKw
                    ? { background: "var(--p-color-bg-surface-warning)", fontWeight: 600 }
                    : undefined
                }
              >
                {raw}
              </span>
            );
          }

          if (t.type === "insert") {
            return (
              <span
                key={i}
                style={{
                  background: "var(--p-color-bg-surface-success)",
                  color: "var(--p-color-text-success)",
                  fontWeight: isKw ? 700 : 400,
                  textDecoration: isKw ? "underline" : "none",
                }}
              >
                {raw}
              </span>
            );
          }

          // delete
          return (
            <span
              key={i}
              style={{
                background: "var(--p-color-bg-surface-critical)",
                color: "var(--p-color-text-critical)",
                textDecoration: "line-through",
                opacity: 0.75,
              }}
            >
              {raw}
            </span>
          );
        })}
      </Box>
    </BlockStack>
  );
}
