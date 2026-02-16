// FILE: app/components/DiffViewer.jsx
import React, { useMemo, useState } from "react";
import { Card, InlineStack, Text, Button, Divider, Box, Banner } from "@shopify/polaris";

import { normalizeKeywords } from "./diffViewer/keywords";
import { KeywordDensityBar } from "./diffViewer/KeywordDensityBar";
import { SafeHtmlFrame } from "./diffViewer/SafeHtmlFrame";
import { TextDiffPane } from "./diffViewer/TextDiffPane";
import { HtmlSourcePane } from "./diffViewer/HtmlSourcePane";

/**
 * DiffViewer (Client/UI)
 * Security contract:
 * - This component must never be used as a trust boundary for HTML writes.
 * - Treat beforeHtml/afterHtml as display-only. Persisting must use server-owned version/job IDs.
 * - Rendering MUST remain XSS-safe (SafeHtmlFrame must sandbox + avoid raw dangerouslySetInnerHTML in main DOM).
 *
 * Drop-in hardening in this file:
 * - Guardrails around input types + size to avoid UI DoS.
 * - Explicit unsafe/oversize banners (fail-closed visual cues; still renders minimal safe states).
 * - Stable modes and memoization to reduce re-renders at scale.
 */

const MODES = /** @type {const} */ (["visual", "diff", "source"]);
const DEFAULT_MODE = "visual";

// UI-level caps to prevent large HTML from freezing the browser.
// IMPORTANT: This does NOT replace server limits. Server must enforce stricter limits.
const MAX_RENDER_CHARS = 250_000; // ~250KB of HTML text per pane
const MAX_KEYWORDS = 250; // keyword highlighting cost guardrail

function isString(x) {
  return typeof x === "string";
}

function clampString(s, maxChars) {
  if (!isString(s)) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

function safeMode(m) {
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

export function DiffViewer({
  beforeHtml = "",
  afterHtml = "",
  keywords = [],
  isLoading = false,
}) {
  const [mode, setMode] = useState(DEFAULT_MODE);

  // Normalize keyword list, but cap to prevent highlighting from becoming O(n*m) expensive.
  const safeKeywords = useMemo(() => {
    const normalized = normalizeKeywords(Array.isArray(keywords) ? keywords : []);
    return normalized.slice(0, MAX_KEYWORDS);
  }, [keywords]);

  // Guard rails for UI robustness: clamp large HTML strings.
  // The server must still:
  //  - sanitize HTML with allowlist sanitizer
  //  - store server-owned versions/jobs
  //  - enforce strict size limits per shop/plan
  const beforeRaw = isString(beforeHtml) ? beforeHtml : "";
  const afterRaw = isString(afterHtml) ? afterHtml : "";

  const beforeTooLarge = beforeRaw.length > MAX_RENDER_CHARS;
  const afterTooLarge = afterRaw.length > MAX_RENDER_CHARS;

  const before = beforeTooLarge ? clampString(beforeRaw, MAX_RENDER_CHARS) : beforeRaw;
  const after = afterTooLarge ? clampString(afterRaw, MAX_RENDER_CHARS) : afterRaw;

  const effectiveMode = safeMode(mode);

  const hasAnyContent = Boolean(beforeRaw || afterRaw);
  const showKeywordBar = effectiveMode !== "source" && hasAnyContent;

  return (
    <Card padding="0">
      <Box padding="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingSm" as="h3">
            Content Review
          </Text>

          <InlineStack gap="100">
            <Button
              pressed={effectiveMode === "visual"}
              size="micro"
              onClick={() => setMode("visual")}
              disabled={isLoading}
              accessibilityLabel="View visual comparison"
            >
              Visual
            </Button>
            <Button
              pressed={effectiveMode === "diff"}
              size="micro"
              onClick={() => setMode("diff")}
              disabled={isLoading}
              accessibilityLabel="View text diff"
            >
              Diff
            </Button>
            <Button
              pressed={effectiveMode === "source"}
              size="micro"
              onClick={() => setMode("source")}
              disabled={isLoading}
              accessibilityLabel="View HTML source"
            >
              HTML
            </Button>
          </InlineStack>
        </InlineStack>
      </Box>

      {(beforeTooLarge || afterTooLarge) && (
        <Box paddingInline="400" paddingBlockEnd="200">
          <Banner tone="warning">
            <p>
              Content is very large and has been truncated for safe preview. Use server-side versioning for
              full fidelity review and apply.
            </p>
          </Banner>
        </Box>
      )}

      {showKeywordBar && (
        <KeywordDensityBar beforeHtml={before} afterHtml={after} keywords={safeKeywords} />
      )}

      <Divider />

      <Box padding="0">
        {effectiveMode === "visual" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 200 }}>
            <Box padding="400" borderInlineEndWidth="1px" borderColor="border">
              <Text variant="bodySm" tone="subdued" fontWeight="bold">
                ORIGINAL
              </Text>
              <Box paddingBlockStart="200">
                {isLoading ? (
                  <Text tone="subdued">Loading...</Text>
                ) : before ? (
                  <SafeHtmlFrame html={before} keywords={safeKeywords} />
                ) : (
                  <Text tone="subdued">Empty</Text>
                )}
              </Box>
            </Box>

            <Box padding="400">
              <Text variant="bodySm" tone="subdued" fontWeight="bold">
                GENERATED
              </Text>
              <Box paddingBlockStart="200">
                {isLoading ? (
                  <Text tone="subdued">Loading...</Text>
                ) : after ? (
                  <SafeHtmlFrame html={after} keywords={safeKeywords} />
                ) : (
                  <Text tone="subdued">No content generated</Text>
                )}
              </Box>
            </Box>
          </div>
        )}

        {effectiveMode === "diff" && (
          <Box padding="400">
            {hasAnyContent ? (
              <TextDiffPane beforeHtml={before} afterHtml={after} keywords={safeKeywords} />
            ) : (
              <Text tone="subdued">Nothing to compare yet.</Text>
            )}
          </Box>
        )}

        {effectiveMode === "source" && (
          <Box padding="400">
            {hasAnyContent ? (
              <HtmlSourcePane html={after || before} keywords={safeKeywords} />
            ) : (
              <Text tone="subdued">&lt;!-- No content --&gt;</Text>
            )}
          </Box>
        )}
      </Box>
    </Card>
  );
}

export default DiffViewer;
