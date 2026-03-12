// FILE: app/components/diffViewer/KeywordDensityBar.jsx
import React, { useMemo } from "react";
import { InlineStack, Text, Tooltip, Box, Badge } from "@shopify/polaris";
import { extractTextForAnalysis } from "./textAnalysis";
import { countKeywordOccurrences, normalizeKeywords } from "./keywords";
import { LIMITS } from "./limits";

/**
 * KeywordDensityBar (UI-side analysis only)
 *
 * Security + performance contract:
 * - Analysis only; never used for persistence.
 * - Work must be bounded: clamp HTML upstream; cap keywords; cap counts.
 */

function fmtDelta(delta) {
  if (delta === 0) return null;
  return delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`;
}

export function KeywordDensityBar({ beforeHtml, afterHtml, keywords }) {
  const stats = useMemo(() => {
    // Defensive keyword normalization (even if caller normalized).
    const safeKeywords = normalizeKeywords(keywords).slice(0, LIMITS.MAX_KEYWORDS);

    if (!safeKeywords.length) return [];

    const bt = extractTextForAnalysis(beforeHtml);
    const at = extractTextForAnalysis(afterHtml);

    // If both empty, bail early.
    if (!bt && !at) return [];

    return safeKeywords.map((kw) => {
      const before = countKeywordOccurrences(bt, kw);
      const after = countKeywordOccurrences(at, kw);
      return { kw, before, after };
    });
  }, [beforeHtml, afterHtml, keywords]);

  if (!stats.length) return null;

  return (
    <Box paddingBlockStart="300" paddingInline="400">
      <InlineStack gap="200" wrap blockAlign="center">
        <Text variant="bodySm" tone="subdued" fontWeight="bold">
          KEYWORDS
        </Text>

        {stats.map(({ kw, before, after }) => {
          const delta = after - before;
          const deltaText = fmtDelta(delta);

          // Use Polaris Badge tones (avoid inline CSS tokens where possible).
          const tone = delta > 0 ? "success" : delta < 0 ? "critical" : "subdued";

          return (
            <Tooltip key={kw} content={`Before: ${before} · After: ${after}`}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Badge tone={tone}>
                  <strong>{kw}</strong>
                </Badge>

                <Text as="span" variant="bodySm" tone="subdued">
                  {after}
                  {deltaText ? ` (${deltaText})` : ""}
                </Text>
              </span>
            </Tooltip>
          );
        })}
      </InlineStack>
    </Box>
  );
}
