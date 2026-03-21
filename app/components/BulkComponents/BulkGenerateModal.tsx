// FILE: app/components/BulkGenerateModal.tsx
//
// Self-contained modal for configuring and submitting a bulk AI generation job.
// Uses its own useFetcher to POST to /app/bulk-generate.
// Calls onSuccess(jobIds) when the server returns ok:true.

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
} from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";

// ── tiny helpers (duplicated intentionally — no shared dep on productId route) ──

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

// ── Types ──────────────────────────────────────────────────────────────────────

interface BulkGenerateModalProps {
  open: boolean;
  /** Shopify GID strings: "gid://shopify/Product/123" */
  selectedProductIds: string[];
  /** Human-readable count label for the header */
  onClose: () => void;
  /** Called with the new jobIds and optional bulkId after successful enqueue */
  onSuccess: (jobIds: string[], bulkId: string | null) => void;
}

interface BulkResult {
  ok: boolean;
  jobIds?: string[];
  skipped?: string[];
  bulkId?: string | null;
  error?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BulkGenerateModal({
  open,
  selectedProductIds,
  onClose,
  onSuccess,
}: BulkGenerateModalProps) {
  const fetcher = useFetcher<BulkResult>();

  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");
  const [includeSocials, setIncludeSocials] = useState(false);

  const isSubmitting = fetcher.state !== "idle";
  const result = fetcher.data;

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

    fetcher.submit(fd, {
      method: "post",
      action: "/app/bulk-generate",
    });
  }, [selectedProductIds, vibe, format, keywords, includeSocials, isSubmitting, fetcher]);

  const count = selectedProductIds.length;
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
          <Badge tone="info">{count} product{count !== 1 ? "s" : ""}</Badge>
        </InlineStack>
      }
      primaryAction={{
        content: isSubmitting
          ? "Queuing…"
          : `✨ Generate for ${count} product${count !== 1 ? "s" : ""}`,
        onAction: handleSubmit,
        loading: isSubmitting,
        disabled: isSubmitting || count === 0,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
      large
    >
      <Modal.Section>
        <BlockStack gap="400">
          {/* Result banners */}
          {result?.ok && (
            <Banner
              tone="success"
              title={`${result.jobIds?.length ?? 0} job${(result.jobIds?.length ?? 0) !== 1 ? "s" : ""} queued successfully`}
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">
                  Jobs are now processing. Track progress on the{" "}
                  <a href="/app/jobs" style={{ color: "#2c6ecb" }}>
                    History
                  </a>{" "}
                  page.
                </Text>
                {(result.skipped?.length ?? 0) > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {result.skipped!.length} product{result.skipped!.length !== 1 ? "s" : ""} skipped (metadata unavailable).
                  </Text>
                )}
              </BlockStack>
            </Banner>
          )}

          {result && !result.ok && (
            <Banner tone="critical" title="Failed to queue jobs">
              {result.error ?? "An unexpected error occurred. Please try again."}
            </Banner>
          )}

          {/* Info card */}
          <Card>
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "#fff7ed",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    flexShrink: 0,
                  }}
                >
                  ✨
                </div>
                <BlockStack gap="0">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {count} product{count !== 1 ? "s" : ""} selected
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Each product will be queued as a separate job. You can monitor and apply results from the History page.
                  </Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Generation settings */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Generation Settings
              </Text>
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

              <BlockStack gap="200">
                <TextField
                  label="Keywords (optional)"
                  value={keywords}
                  onChange={(v) => setKeywords(clamp(v, 2000))}
                  placeholder="e.g. organic cotton, eco-friendly, sustainable"
                  autoComplete="off"
                  disabled={isSubmitting}
                  helpText="Comma-separated SEO keywords applied to all products."
                />

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
              </BlockStack>

              <Checkbox
                label="Include Instagram caption"
                checked={includeSocials}
                onChange={setIncludeSocials}
                disabled={isSubmitting}
              />
            </BlockStack>
          </Card>

          {/* Generating state */}
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