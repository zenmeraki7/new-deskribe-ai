// FILE: app/routes/app.products.$productId.ui.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Select,
  TextField,
  Button,
  Badge,
  Spinner,
  Checkbox,
  InlineGrid,
} from "@shopify/polaris";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";

import type { LoaderData, DraftResult } from "./app.products.$productId.types";
import {
  JOB_POLL_INTERVAL_MS,
  JOB_POLL_JITTER_RATIO,
  KEYWORDS,
  UUID_V4_RE,
} from "./app.products.$productId.constants";

import { DiffViewer } from "../components/DiffViewer";

// ─────────────────────────────────────────────────────────────────────────────
// UI-only helpers
// IMPORTANT: No client-side “sanitizers”. All HTML must be sanitized on server.
// Rendering is sandboxed inside DiffViewer iframes (defense-in-depth).
// ─────────────────────────────────────────────────────────────────────────────

function isUuidV4(jobId: string) {
  return UUID_V4_RE.test(jobId);
}

function parseKeywords(input: string): string[] {
  const raw = String(input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  let total = 0;

  for (const kw0 of raw) {
    const kw = kw0.slice(0, KEYWORDS.MAX_EACH_CHARS);
    if (!kw) continue;

    const lower = kw.toLowerCase();
    if (out.some((x) => x.toLowerCase() === lower)) continue;

    total += kw.length;
    if (out.length >= KEYWORDS.MAX) break;
    if (total > KEYWORDS.MAX_TOTAL_CHARS) break;

    out.push(kw);
  }

  return out;
}

function clampTextInput(value: string, maxChars: number) {
  const s = typeof value === "string" ? value : "";
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

type PollStatus = "IDLE" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface PollPayload {
  status: PollStatus;
  result: DraftResult | null;
  errorMessage: string | null;
}

/**
 * Job polling hook (UI-only)
 *
 * Assumption (safest default): /app/api/job/:jobId is authenticated + shop-scoped
 * and returns server-sanitized result.body_html.
 *
 * Hardening:
 * - Jittered polling to avoid herd effects
 * - Tab visibility guard
 * - Timer cleanup on unmount and on jobId changes (prevents leaks)
 * - Fail-closed: if jobId invalid, do nothing
 */
function useJobPoll() {
  const fetcher = useFetcher<PollPayload>();
  const timerRef = useRef<number | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<PollStatus>("IDLE");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastCompletedJobId, setLastCompletedJobId] = useState<string | null>(null);

  const terminal = useMemo(() => new Set<PollStatus>(["COMPLETED", "FAILED", "CANCELLED"]), []);

  const stop = useCallback(() => {
    setJobId(null);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleMs = useCallback(() => {
    const base = JOB_POLL_INTERVAL_MS;
    const jitter = base * JOB_POLL_JITTER_RATIO;
    return Math.max(750, Math.floor(base + (Math.random() * 2 - 1) * jitter));
  }, []);

  useEffect(() => {
    // Always clear any pending timeouts when jobId changes/unmount.
    clearTimer();

    if (!jobId) return;

    let stopped = false;

    const tick = () => {
      if (stopped) return;

      // Pause when tab hidden to reduce unnecessary load.
      if (typeof document !== "undefined" && document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }

      fetcher.load(`/app/api/job/${jobId}`);

      timerRef.current = window.setTimeout(tick, scheduleMs());
    };

    tick();

    return () => {
      stopped = true;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, clearTimer, scheduleMs]);

  useEffect(() => {
    if (!fetcher.data) return;

    const nextStatus: PollStatus = fetcher.data.status ?? "IDLE";
    setStatus(nextStatus);
    setErrorMessage(fetcher.data.errorMessage ?? null);

    if (fetcher.data.result) setResult(fetcher.data.result);

    if (terminal.has(nextStatus)) {
      if (nextStatus === "COMPLETED" && jobId) setLastCompletedJobId(jobId);
      stop();
    }
  }, [fetcher.data, stop, terminal, jobId]);

  const startPolling = useCallback((id: string) => {
    if (!isUuidV4(id)) return;
    setResult(null);
    setErrorMessage(null);
    setStatus("PENDING");
    setJobId(id);
  }, []);

  return {
    startPolling,
    status,
    result,
    errorMessage,
    jobId, // current polled job
    lastCompletedJobId, // server-owned job id that completed
    isPolling: status !== "IDLE" && !terminal.has(status),
    stop,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main route UI
// ─────────────────────────────────────────────────────────────────────────────

export default function ProductEditorModalRoute() {
  const { product, activeJob, latestDraft, policyWarnings } = useLoaderData<LoaderData>();

  const navigate = useNavigate();

  // Form state (bounded / UI-only)
  const [vibe, setVibe] = useState<string>("casual");
  const [format, setFormat] = useState<string>("paragraph");
  const [keywords, setKeywords] = useState<string>("");
  const [includeSocials, setIncludeSocials] = useState<boolean>(false);

  // Fetchers
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();
  const descFetcher = useFetcher<any>();
  const keywordFetcher = useFetcher<any>();

  const {
    startPolling,
    status: pollStatus,
    result: pollResult,
    errorMessage: pollErrorMessage,
    lastCompletedJobId,
    isPolling,
  } = useJobPoll();

  // Start polling when generate returns jobId
  useEffect(() => {
  const data = generateFetcher.data;
  const jobId = data?.jobId;

  if (data?.ok && typeof jobId === "string" && isUuidV4(jobId)) {
    startPolling(jobId);
  }
}, [generateFetcher.data?.jobId, startPolling]);

  // Auto-resume polling if an active job exists (on mount)
  useEffect(() => {
    if (activeJob && (activeJob.status === "PENDING" || activeJob.status === "PROCESSING")) {
      startPolling(activeJob.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy load current description
  const handleLoadComparison = useCallback(() => {
    if (descFetcher.state !== "idle") return;
    const fd = new FormData();
    fd.set("intent", "fetch_description");
    descFetcher.submit(fd, { method: "post" });
  }, [descFetcher]);

  // Suggest keywords (server-owned meta; do NOT send client fields)
  const handleSuggestKeywords = useCallback(() => {
    if (keywordFetcher.state !== "idle") return;
    const fd = new FormData();
    fd.set("intent", "suggest_keywords");
    keywordFetcher.submit(fd, { method: "post" });
  }, [keywordFetcher]);

  const suggestedKeywords: string[] =
  keywordFetcher.data?.ok && Array.isArray(keywordFetcher.data?.keywords)
    ? keywordFetcher.data.keywords
    : [];

    const handleAddSuggestedKeyword = useCallback((kw: string) => {
  setKeywords((prev) => {
    const existing = prev.split(",").map((k) => k.trim()).filter(Boolean);
    if (existing.some((k) => k.toLowerCase() === kw.toLowerCase())) return prev;
    return [...existing, kw].join(", ");
  });
}, []);


  const isGenerating =
    isPolling ||
    generateFetcher.state !== "idle" ||
    pollStatus === "PENDING" ||
    pollStatus === "PROCESSING";

  const isApplying = applyFetcher.state !== "idle";

  // Draft source precedence: live poll result → latestDraft from loader (already server-sanitized)
  const draftResult: DraftResult | null = (pollResult as DraftResult | null) ?? (latestDraft?.result ?? null);

  const draftHtml = typeof draftResult?.body_html === "string" ? draftResult.body_html : "";
  const currentHtml = typeof descFetcher.data?.descriptionHtml === "string" ? descFetcher.data.descriptionHtml : "";

  const highlightKeywords = useMemo(() => parseKeywords(keywords), [keywords]);

  const generateError =
  generateFetcher.data?.intent === "generate" &&
  generateFetcher.data?.ok === false
    ? String(generateFetcher.data.error ?? "")
    : "";

  const applyError =
    applyFetcher.data && applyFetcher.data.ok === false ? String(applyFetcher.data.error ?? "") : "";
  const applySuccess = applyFetcher.data?.ok === true && applyFetcher.data?.applied === true;

  const handleClose = () => navigate("/app/products");

  // Temporarily add this right before the DiffViewer in your ui.tsx:
useEffect(() => {
  if (draftResult) {
    console.log("=== DRAFT RESULT ===", JSON.stringify(draftResult, null, 2));
    console.log("=== DRAFT HTML ===", draftHtml);
  }
}, [draftResult, draftHtml]);

  // Apply must use server-owned job id:
  // - Prefer the last completed polled job
  // - Else fallback to latestDraft.id (server-owned completed job id from loader)
  const applyJobId = lastCompletedJobId ?? latestDraft?.id ?? null;

  const canApply = Boolean(
    draftResult &&
      draftHtml &&
      applyJobId &&
      isUuidV4(applyJobId) &&
      !isApplying &&
      !isGenerating &&
      pollStatus !== "PENDING" &&
      pollStatus !== "PROCESSING",
  );

  const primaryGenerateDisabled = isGenerating; // server also enforces idempotency


  return (
    <Modal
      open
      onClose={handleClose}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            {product.title}
          </Text>
          {latestDraft && <Badge tone="info">Draft exists</Badge>}
          {isGenerating && <Badge tone="attention">Generating…</Badge>}
        </InlineStack>
      }
      primaryAction={{
        content: isGenerating ? "Generating…" : "Generate Draft",
        onAction: () => {
          const fd = new FormData();
          fd.set("intent", "generate");
          fd.set("vibe", clampTextInput(vibe, 40));
          fd.set("format", clampTextInput(format, 40));
          fd.set("keywords", clampTextInput(keywords, 2000)); // server re-normalizes & caps
          fd.set("includeSocials", String(includeSocials));
          generateFetcher.submit(fd, { method: "post" });
        },
        loading: isGenerating,
        disabled: primaryGenerateDisabled,
      }}
      secondaryActions={[{ content: "Close", onAction: handleClose }]}
      large
    >
      <Modal.Section>
        <BlockStack gap="400">
          {/* Banners */}
          {policyWarnings.length > 0 && (
            <Banner tone="warning" title="SEO Policy Warnings">
              <ul>
                {policyWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}

          {generateError && (
            <Banner tone="critical" title="Generation failed">
              {generateError}
            </Banner>
          )}

          {pollStatus === "FAILED" && (
            <Banner tone="critical" title="Generation failed">
              {pollErrorMessage ?? "The AI job failed. Please try again."}
            </Banner>
          )}

          {pollStatus === "CANCELLED" && (
            <Banner tone="warning" title="Generation cancelled">
              The job was cancelled.
            </Banner>
          )}

          {applyError && (
            <Banner tone="critical" title="Apply failed">
              {applyError}
            </Banner>
          )}

          {applySuccess && (
            <Banner tone="success" title="Applied to Shopify">
              The draft description is now live on this product.
            </Banner>
          )}

          {/* Generation inputs */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Generation Settings
              </Text>

              <InlineGrid columns={2} gap="300">
                <Select
                  label="Writing style"
                  options={[
                    { label: "Casual", value: "casual" },
                    { label: "Luxury", value: "luxury" },
                    { label: "Technical", value: "technical" },
                    { label: "Playful", value: "playful" },
                    { label: "Minimalist", value: "minimalist" },
                  ]}
                  value={vibe}
                  onChange={setVibe}
                  disabled={isGenerating}
                />

                <Select
                  label="Format"
                  options={[
                    { label: "Paragraph", value: "paragraph" },
                    { label: "Bullets", value: "bullets" },
                    { label: "Hybrid", value: "hybrid" },
                  ]}
                  value={format}
                  onChange={setFormat}
                  disabled={isGenerating}
                />
              </InlineGrid>

              <InlineStack gap="200" blockAlign="end">
                {/* Keywords field — replace the existing InlineStack gap="200" block with this: */}
<BlockStack gap="200">
  <InlineStack gap="200" blockAlign="end">
    <div style={{ flex: 1 }}>
      <TextField
        label="Keywords"
        value={keywords}
        onChange={(v) => setKeywords(clampTextInput(v, 2000))}
        placeholder="e.g. organic cotton, eco-friendly t-shirt"
        autoComplete="off"
        disabled={isGenerating}
        helpText="Comma-separated seed keywords for SEO targeting."
      />
    </div>
    <div style={{ paddingTop: 22 }}>
      <Button
        onClick={handleSuggestKeywords}
        loading={keywordFetcher.state !== "idle"}
        disabled={isGenerating}
        size="slim"
      >
        ✨ Suggest
      </Button>
    </div>
  </InlineStack>

  {/* Current keyword tags */}
  {parseKeywords(keywords).length > 0 && (
    <InlineStack gap="100" wrap>
      {parseKeywords(keywords).map((kw) => (
        <div
          key={kw}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "#f1f2f3",
            border: "1px solid #c9cccf",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 13,
          }}
        >
          {kw}
          <button
            onClick={() =>
              setKeywords(
                parseKeywords(keywords)
                  .filter((k) => k !== kw)
                  .join(", ")
              )
            }
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0 2px",
              fontSize: 12,
              color: "#6d7175",
            }}
          >
            ×
          </button>
        </div>
      ))}
    </InlineStack>
  )}

  {/* Suggested keyword chips */}
  {suggestedKeywords.length > 0 && (
    <BlockStack gap="100">
      <Text variant="bodySm" tone="subdued">
        Suggested — click to add:
      </Text>
      <InlineStack gap="100" wrap>
        {suggestedKeywords.map((kw) => (
          <button
            key={kw}
            onClick={() => handleAddSuggestedKeyword(kw)}
            style={{
              background: "none",
              border: "1px solid #c9cccf",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 13,
              color: "#202223",
            }}
          >
            + {kw}
          </button>
        ))}
      </InlineStack>
    </BlockStack>
  )}
</BlockStack>
              </InlineStack>

              <Checkbox
                label="Include Instagram caption"
                checked={includeSocials}
                onChange={setIncludeSocials}
                disabled={isGenerating}
              />
            </BlockStack>
          </Card>

          {/* AI generation progress */}
         {isGenerating && (
  <Card>
    <InlineStack gap="300" blockAlign="center">
      <Spinner size="small" />
      <Text as="p">
        {pollStatus === "PROCESSING"
          ? "Deskribe AI is generating your product description…"
          : "Preparing to generate your product description…"}
      </Text>
    </InlineStack>
  </Card>
)}

          {/* SEO meta preview (plain text only) */}
          {draftResult && (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  SEO Preview
                </Text>

                <div
                  style={{
                    padding: 16,
                    background: "#fff",
                    border: "1px solid #dadce0",
                    borderRadius: 8,
                    fontFamily: "arial, sans-serif",
                    maxWidth: 600,
                  }}
                >
                  <div
                    style={{
                      fontSize: 18,
                      color: "#1a0dab",
                      marginBottom: 4,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {draftResult.meta_title ?? product.title}
                  </div>
                  <div style={{ fontSize: 13, color: "#006621", marginBottom: 4 }}>
                    {`your-store.myshopify.com › products`}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "#545454",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {draftResult.meta_description ?? ""}
                  </div>
                </div>

                {Array.isArray(draftResult.keywords) && draftResult.keywords.length > 0 && (
                  <InlineStack gap="200" wrap>
                    {draftResult.keywords
                      .filter((kw) => typeof kw === "string" && kw.trim())
                      .slice(0, 30)
                      .map((kw) => (
                        <Badge key={kw} tone="info">
                          {kw}
                        </Badge>
                      ))}
                  </InlineStack>
                )}

                {draftResult.social_caption && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Instagram caption:
                    </Text>
                    <Text as="p" variant="bodySm">
                      {draftResult.social_caption}
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          )}

          {/* Compare / Diff view */}
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Compare
                </Text>
                {!currentHtml && (
                  <Button onClick={handleLoadComparison} loading={descFetcher.state !== "idle"} size="slim">
                    Load current description
                  </Button>
                )}
              </InlineStack>

              <DiffViewer
                beforeHtml={currentHtml} // server-sanitized by fetch_description
                afterHtml={draftHtml} // server-sanitized by loader/poll endpoint
                keywords={highlightKeywords} // highlight-only
                isLoading={descFetcher.state !== "idle"}
              />
            </BlockStack>
          </Card>

          {/* Apply to Shopify */}
          {(latestDraft || pollStatus === "COMPLETED") && (
            <InlineStack align="end">
              <Button
                variant="primary"
                tone="success"
                disabled={!canApply}
                loading={isApplying}
                onClick={() => {
                  if (!applyJobId || !isUuidV4(applyJobId)) return;

                  const fd = new FormData();
                  fd.set("intent", "apply");
                  fd.set("jobId", applyJobId);
                  applyFetcher.submit(fd, { method: "post" });
                }}
              >
                Apply to Shopify
              </Button>
            </InlineStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}