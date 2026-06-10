// FILE: app/components/BulkGenerateModal.tsx

import React, { useCallback, useEffect, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  TextField,
  Checkbox,
  Text,
  Badge,
  Banner,
  Card,
  Spinner,
  Button,
} from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";

const VIBE_OPTIONS = [
  { label: "Casual", value: "casual" },
  { label: "Luxury", value: "luxury" },
  { label: "Technical", value: "technical" },
  { label: "Playful", value: "playful" },
  { label: "Minimalist", value: "minimalist" },
];

const FORMAT_OPTIONS = [
  { label: "Paragraph", value: "paragraph" },
  { label: "Bullets", value: "bullets" },
  { label: "Hybrid", value: "hybrid" },
];

function clamp(value: string, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function parseKeywords(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

interface BulkGenerateModalProps {
  open: boolean;
  selectedProductIds: string[];
  onClose: () => void;
  onSuccess: (jobIds: string[], bulkId: string | null) => void;
}

interface BulkKeywordResult {
  ok: boolean;
  keywords?: string[];
  error?: string;
  code?: string;
}

interface BulkResult {
  ok: boolean;
  jobIds?: string[];
  skipped?: string[];
  bulkId?: string | null;
  error?: string;
  code?: string;
  plan?: string;
}

export function BulkGenerateModal({
  open,
  selectedProductIds,
  onClose,
  onSuccess,
}: BulkGenerateModalProps) {
  const fetcher = useFetcher<BulkResult>();
  const keywordFetcher = useFetcher<BulkKeywordResult>();

  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);

  const isSubmitting = fetcher.state !== "idle";
  const isSuggestingKeywords = keywordFetcher.state !== "idle";
  const result = fetcher.data;

  const suggestedKeywords: string[] =
    keywordFetcher.data?.ok && Array.isArray(keywordFetcher.data?.keywords)
      ? keywordFetcher.data.keywords
      : [];

  // Notify parent on success
  useEffect(() => {
    if (result?.ok && Array.isArray(result.jobIds) && result.jobIds.length > 0) {
      onSuccess(result.jobIds, result.bulkId ?? null);
    }
  }, [result, onSuccess]);

  // Reset form when modal re-opens
  useEffect(() => {
    if (open) {
      setVibe("casual");
      setFormat("paragraph");
      setKeywords("");
      setIncludeSocials(false);
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (selectedProductIds.length === 0 || isSubmitting) return;
    const fd = new FormData();
    fd.set("intent", "bulk_generate");
    fd.set("productIds", JSON.stringify(selectedProductIds));
    fd.set("vibe", clamp(vibe, 40));
    fd.set("format", clamp(format, 40));
    fd.set("keywords", clamp(keywords, 2000));
    fd.set("includeSocials", String(includeSocials));
    fetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [selectedProductIds, vibe, format, keywords, includeSocials, isSubmitting, fetcher]);

  // ── Keyword suggestion ──────────────────────────────────────────────────────
  const handleSuggestKeywords = useCallback(() => {
    if (isSuggestingKeywords || selectedProductIds.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "suggest_keywords_bulk");
    fd.set("productIds", JSON.stringify(selectedProductIds));
    keywordFetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [isSuggestingKeywords, selectedProductIds, keywordFetcher]);

  const handleAddSuggestedKeyword = useCallback((kw: string) => {
    setKeywords((prev) => {
      const existing = prev.split(",").map((k) => k.trim()).filter(Boolean);
      if (existing.some((k) => k.toLowerCase() === kw.toLowerCase())) return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  const count = selectedProductIds.length;
  const creditCost = count;
  const kwList = parseKeywords(keywords);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            Bulk Generate AI Descriptions
          </Text>
          <Badge tone="info">{`${count} product${count !== 1 ? "s" : ""}`}</Badge>
        </InlineStack>
      }
      primaryAction={{
        content: isSubmitting ? "Queuing…" : `✨ Generate for ${count} product${count !== 1 ? "s" : ""}`,
        onAction: handleSubmit,
        loading: isSubmitting,
        disabled: isSubmitting || count === 0,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">

          {/* Success banner */}
          {result?.ok && (
            <Banner
              tone="success"
              title={`${result.jobIds?.length ?? 0} job${(result.jobIds?.length ?? 0) !== 1 ? "s" : ""} queued successfully`}
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">
                  Jobs are now processing. Track progress on the{" "}
                  <a href="/app/jobs" style={{ color: "#2c6ecb" }}>History</a> page.
                </Text>
                {(result.skipped?.length ?? 0) > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {result.skipped!.length} product{result.skipped!.length !== 1 ? "s" : ""} skipped (metadata unavailable).
                  </Text>
                )}
              </BlockStack>
            </Banner>
          )}

          {/* Error banner */}
          {result && !result.ok && (() => {
            const isRateLimit =
              result.code === "RATE_LIMIT_EXCEEDED" ||
              result.code === "GLOBAL_LIMIT_REACHED";
            return (
              <Banner
                tone={isRateLimit ? "warning" : "critical"}
                title={result.code === "INSUFFICIENT_CREDITS" ? "Not enough credits" : isRateLimit ? "Service temporarily busy" : "Failed to queue jobs"}
              >
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">
                    {result.error ?? "An unexpected error occurred. Please try again."}
                  </Text>
                </BlockStack>
              </Banner>
            );
          })()}

          {/* Info card */}
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  Credit cost before generation
                </Text>
                <Badge tone="info">{`${creditCost} credit${creditCost === 1 ? "" : "s"}`}</Badge>
              </InlineStack>
  <InlineStack gap="200" blockAlign="end">
    <div style={{ flex: 1 }}>
      <TextField
        label="Keywords (optional)"
        value={keywords}
        onChange={(v) => setKeywords(clamp(v, 2000))}
        placeholder="e.g. organic cotton, eco-friendly, sustainable"
        autoComplete="off"
        disabled={isSubmitting}
        helpText="Comma-separated SEO keywords applied to all products."
      />
    </div>    <div style={{ paddingTop: 22 }}>
      <Button
        onClick={handleSuggestKeywords}
        loading={isSuggestingKeywords}
        disabled={isSubmitting || count === 0}
        size="slim"
      >
        Suggest
      </Button>
    </div>
  </InlineStack>

  {/* Current keyword tags */}
  {kwList.length > 0 && (
    <InlineStack gap="100" wrap>
      {kwList.map((kw) => (
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
                  .join(", "),
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
      <Text as="p" variant="bodySm" tone="subdued">
        Suggested for your selection — click to add:
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
          </Card>

          {/* Generation settings */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Generation Settings</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                These settings apply to all selected products.
              </Text>

              <InlineGrid columns={2} gap="300">
                <Select
                  label="Writing style"
                  options={VIBE_OPTIONS}
                  value={vibe}
                  onChange={setVibe}
                  disabled={isSubmitting}
                />
                <Select
                  label="Format"
                  options={FORMAT_OPTIONS}
                  value={format}
                  onChange={setFormat}
                  disabled={isSubmitting}
                />
              </InlineGrid>

              {/* ── Keywords with Suggest button ── */}
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    {/* <TextField
                      label="Keywords (optional)"
                      value={keywords}
                      onChange={(v) => setKeywords(clamp(v, 2000))}
                      placeholder="e.g. organic cotton, eco-friendly, sustainable"
                      autoComplete="off"
                      disabled={isSubmitting}
                      helpText="Comma-separated SEO keywords applied to all products."
                    /> */}
                  </div>
                  <div style={{ paddingTop: 22 }}>
                    {/* <Button
                      onClick={handleSuggestKeywords}
                      loading={isSuggestingKeywords}
                      disabled={isSubmitting || count === 0}
                      size="slim"
                    >
                      ✨ Suggest
                    </Button> */}
                  </div>
                </InlineStack>

                {/* Current keyword tags */}
                {kwList.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {kwList.map((kw) => (
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
                                .join(", "),
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
                    <Text as="p" variant="bodySm" tone="subdued">
                      Suggested for your selection — click to add:
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

                {/* Keyword suggestion error */}
                {keywordFetcher.data?.ok === false && (
                  <Text as="p" variant="bodySm" tone="critical">
                    Could not suggest keywords. Please try again.
                  </Text>
                )}
              </BlockStack>

              {/* <Checkbox
                label="Include Instagram caption"
                checked={includeSocials}
                onChange={setIncludeSocials}
                disabled={isSubmitting}
              /> */}
            </BlockStack>
          </Card>

          {/* Submitting state */}
          {isSubmitting && (
            <Card>
              <InlineStack gap="300" blockAlign="center">
                <Spinner size="small" />
                <Text as="p">
                  Queueing {count} job{count !== 1 ? "s" : ""}…
                </Text>
              </InlineStack>
            </Card>
          )}

        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

