// FILE: app/components/diffViewer/KeywordDensityBar.tsx
import React, { type FocusEvent, useMemo } from "react";
import { Badge, Box, InlineStack, Text, Tooltip } from "@shopify/polaris";
import { extractTextForAnalysis } from "./textAnalysis";
import {
  buildKeywordOccurrenceRegex,
  countKeywordOccurrencesRaw,
  normalizeKeywords,
} from "./keywords";
import { LIMITS } from "./limits";

/**
 * KeywordDensityBar (UI-side analysis only)
 *
 * Security + performance contract:
 * - Analysis only; never used for persistence.
 * - Work must be bounded: clamp HTML upstream; cap keywords; cap counts.
 */

type KeywordStat = {
  kw: string;
  before: number;
  after: number;
};

type KeywordDensityBarProps = {
  beforeHtml?: unknown;
  afterHtml?: unknown;
  keywords?: unknown;
};

function fmtDelta(delta: number) {
  if (delta === 0) return null;
  return delta > 0 ? `+${delta}` : `-${Math.abs(delta)}`;
}

function getTone(delta: number) {
  if (delta > 0) return "success";
  if (delta < 0) return "critical";
  return undefined;
}

function countText(count: number) {
  return count === 0 ? "-" : String(count);
}

function tooltipCountText(count: number) {
  return count === 0 ? "not found" : String(count);
}

function handleActivatorFocus(event: FocusEvent<HTMLSpanElement>) {
  event.currentTarget.style.boxShadow =
    "0 0 0 2px var(--p-color-border-focus)";
}

function handleActivatorBlur(event: FocusEvent<HTMLSpanElement>) {
  event.currentTarget.style.boxShadow = "none";
}

export function KeywordDensityBar({
  beforeHtml,
  afterHtml,
  keywords,
}: KeywordDensityBarProps) {
  const stats = useMemo<KeywordStat[]>(() => {
    const safeKeywords = normalizeKeywords(keywords).slice(0, LIMITS.MAX_KEYWORDS);

    if (!safeKeywords.length) return [];

    const beforeText = extractTextForAnalysis(beforeHtml);
    const afterText = extractTextForAnalysis(afterHtml);

    if (!beforeText && !afterText) return [];

    return safeKeywords.map((kw: string) => {
      const regex = buildKeywordOccurrenceRegex(kw);
      const before = beforeText ? countKeywordOccurrencesRaw(regex, beforeText) : 0;
      const after = afterText ? countKeywordOccurrencesRaw(regex, afterText) : 0;
      return { kw, before, after };
    });
  }, [beforeHtml, afterHtml, keywords]);

  if (!stats.length) return null;

  return (
    <Box paddingBlockStart="300" paddingInline="400">
      <InlineStack gap="200" wrap blockAlign="center">
        <Text as="span" variant="bodySm" tone="subdued" fontWeight="bold">
          KEYWORDS
        </Text>

        {stats.map(({ kw, before, after }) => {
          const delta = after - before;
          const deltaText = fmtDelta(delta);

          return (
            <Tooltip
              key={kw}
              content={`Before: ${tooltipCountText(before)} | After: ${tooltipCountText(after)}`}
            >
              <span
                tabIndex={0}
                onFocus={handleActivatorFocus}
                onBlur={handleActivatorBlur}
                style={{
                  borderRadius: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  outline: "none",
                }}
              >
                <Badge tone={getTone(delta)}>{kw}</Badge>

                <Text
                  as="span"
                  variant="bodySm"
                  tone={after === 0 ? "disabled" : "subdued"}
                >
                  {countText(after)}
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
