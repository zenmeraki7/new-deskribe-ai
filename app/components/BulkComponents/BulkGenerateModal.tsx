// FILE: app/components/BulkComponents/BulkGenerateModal.tsx

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  TextField,
  Text,
  Badge,
  Banner,
  Card,
  Spinner,
  Button,
  Popover,
  Checkbox,
  Box,
} from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { CREDIT_COSTS, formatCredits, hasCredits } from "../../lib/credits";
import { BulkLiveResults } from "./BulkLiveResults";

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

type SectionKey = "description" | "meta" | "alttext";

const SECTION_LABELS: Record<SectionKey, string> = {
  description: "Description",
  meta: "Meta title & description",
  alttext: "Image alt text",
};

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
  creditsRemaining: number;
  shopDomain: string;
}

interface BulkKeywordResult {
  ok: boolean;
  keywords?: string[];
  error?: string;
  code?: string;
  plan?: string;
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

interface BulkMetaResult {
  ok: boolean;
  results?: { productId: string; meta_title: string; meta_description: string }[];
  error?: string;
  code?: string;
}

interface BulkAltTextResult {
  ok: boolean;
  results?: { productId: string; imageId: string; altText: string }[];
  applied?: number;
  error?: string;
  code?: string;
}

export function BulkGenerateModal({
  open,
  selectedProductIds,
  onClose,
  onSuccess,
  creditsRemaining,
  shopDomain,
}: BulkGenerateModalProps) {
  const fetcher = useFetcher<BulkResult>();
  const keywordFetcher = useFetcher<BulkKeywordResult>();
  const metaFetcher = useFetcher<BulkMetaResult>();
  const applyMetaFetcher = useFetcher<{ ok: boolean; error?: string; applied?: number }>();
  const altTextFetcher = useFetcher<BulkAltTextResult>();
  const applyAltTextFetcher = useFetcher<{ ok: boolean; error?: string; applied?: number }>();

  // ── Section selector state (replaces tabs) ────────────────────────────────
  const [selectedSections, setSelectedSections] = useState<SectionKey[]>(["description"]);
  const [sectionsGenerated, setSectionsGenerated] = useState<SectionKey[]>([]);
  const [sectionPopoverActive, setSectionPopoverActive] = useState(false);

  const toggleSection = useCallback((key: SectionKey, checked: boolean) => {
    setSelectedSections((prev) => {
      if (checked) return prev.includes(key) ? prev : [...prev, key];
      return prev.filter((s) => s !== key);
    });
  }, []);

  // ── Description state ─────────────────────────────────────────────────────
  const [vibe, setVibe] = useState("casual");
  const [format, setFormat] = useState("paragraph");
  const [keywords, setKeywords] = useState("");

  // ── Live bulk run state (NEW) ──────────────────────────────────────────────
  // Once a description run is queued, we stop showing the settings form and
  // switch to the live progress/results view. The modal stays open.
  const [queuedBulkId, setQueuedBulkId] = useState<string | null>(null);
  const [hasNotifiedQueued, setHasNotifiedQueued] = useState(false);

  // ── Meta state ────────────────────────────────────────────────────────────
  const [metaResults, setMetaResults] = useState<
  { productId: string; meta_title: string; meta_description: string }[]
>([]);
  const [metaApplied, setMetaApplied] = useState(false);

  // ── Alt text state ────────────────────────────────────────────────────────
  const [altTextResults, setAltTextResults] = useState<
  { productId: string; imageId: string; altText: string }[]
>([]);

  const [altTextApplied, setAltTextApplied] = useState(false);

  const isSubmitting = fetcher.state !== "idle";
  const isSuggestingKeywords = keywordFetcher.state !== "idle";
  const isGeneratingMeta = metaFetcher.state !== "idle";
  const isApplyingMeta = applyMetaFetcher.state !== "idle";
  const isGeneratingAltText = altTextFetcher.state !== "idle";
  const isApplyingAltText = applyAltTextFetcher.state !== "idle";

  const result = fetcher.data;

  const suggestedKeywords: string[] =
    keywordFetcher.data?.ok && Array.isArray(keywordFetcher.data?.keywords)
      ? keywordFetcher.data.keywords
      : [];

  const count = selectedProductIds.length;
  const creditCost = count * CREDIT_COSTS.bulkProductGeneration;
  const metaCreditCost = count * CREDIT_COSTS.metaGeneration;
  const altTextCreditCost = count * CREDIT_COSTS.altTextGeneration;

  const canGenerateWithCredits = hasCredits(creditsRemaining, creditCost);
  const canGenerateMetaWithCredits = hasCredits(creditsRemaining, metaCreditCost);
  const canGenerateAltTextWithCredits = hasCredits(creditsRemaining, altTextCreditCost);
  const canSuggestWithCredits = hasCredits(creditsRemaining, CREDIT_COSTS.keywordSuggestion);

  // ── Switch to live results once a run is queued (NEW) ─────────────────────
  useEffect(() => {
    if (result?.ok && result.bulkId && !queuedBulkId) {
      setQueuedBulkId(result.bulkId);
    }
  }, [result, queuedBulkId]);

  // Notify parent exactly once so it can clear the IndexTable selection —
  // does NOT close the modal (see prop doc comment above).
  useEffect(() => {
    if (queuedBulkId && result?.jobIds && !hasNotifiedQueued) {
      setHasNotifiedQueued(true);
      onSuccess(result.jobIds, queuedBulkId);
    }
  }, [queuedBulkId, result, hasNotifiedQueued, onSuccess]);

  // ── Handle meta generation result ─────────────────────────────────────────
  useEffect(() => {
    if (metaFetcher.data?.ok && Array.isArray(metaFetcher.data.results)) {
      setMetaResults(metaFetcher.data.results);
      setMetaApplied(false);
    }
  }, [metaFetcher.data]);

  // ── Handle meta apply result ──────────────────────────────────────────────
  useEffect(() => {
    if (applyMetaFetcher.data?.ok) {
      setMetaApplied(true);
    }
  }, [applyMetaFetcher.data]);

  // ── Handle alt text generation result ────────────────────────────────────
  useEffect(() => {
    if (altTextFetcher.data?.ok && Array.isArray(altTextFetcher.data.results)) {
      setAltTextResults(altTextFetcher.data.results);
      setAltTextApplied(false);
    }
  }, [altTextFetcher.data]);

  // ── Handle alt text apply result ──────────────────────────────────────────
  useEffect(() => {
    if (applyAltTextFetcher.data?.ok) {
      setAltTextApplied(true);
    }
  }, [applyAltTextFetcher.data]);

  // ── Reset form when modal re-opens ────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setSelectedSections(["description"]);
      setSectionsGenerated([]);
      setVibe("casual");
      setFormat("paragraph");
      setKeywords("");
      setMetaResults([]);
      setMetaApplied(false);
      setAltTextResults([]);
      setAltTextApplied(false);
      setQueuedBulkId(null);
      setHasNotifiedQueued(false);
    }
  }, [open]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleGenerateDescription = useCallback(() => {
    if (selectedProductIds.length === 0 || isSubmitting || queuedBulkId) return;
    if (!canGenerateWithCredits) return;
    const fd = new FormData();
    fd.set("intent", "bulk_generate");
    fd.set("productIds", JSON.stringify(selectedProductIds));
    fd.set("vibe", clamp(vibe, 40));
    fd.set("format", clamp(format, 40));
    fd.set("keywords", clamp(keywords, 2000));
    fd.set("includeSocials", "false");
    fetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [selectedProductIds, vibe, format, keywords, isSubmitting, canGenerateWithCredits, queuedBulkId, fetcher]);

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

  const handleGenerateMeta = useCallback(() => {
    if (!canGenerateMetaWithCredits || isGeneratingMeta) return;
    const fd = new FormData();
    fd.set("intent", "bulk_generate_meta");
    fd.set("productIds", JSON.stringify(selectedProductIds));
    fd.set("keywords", clamp(keywords, 2000));
    metaFetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [canGenerateMetaWithCredits, isGeneratingMeta, selectedProductIds, keywords, metaFetcher]);

  const handleApplyMeta = useCallback(() => {
    if (metaResults.length === 0 || isApplyingMeta) return;
    const fd = new FormData();
    fd.set("intent", "bulk_apply_meta");
    fd.set("items", JSON.stringify(metaResults));
    applyMetaFetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [metaResults, isApplyingMeta, applyMetaFetcher]);

  const handleGenerateAltText = useCallback(() => {
    if (!canGenerateAltTextWithCredits || isGeneratingAltText) return;
    const fd = new FormData();
    fd.set("intent", "bulk_generate_alt_text");
    fd.set("productIds", JSON.stringify(selectedProductIds));
    altTextFetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [canGenerateAltTextWithCredits, isGeneratingAltText, selectedProductIds, altTextFetcher]);

  const handleApplyAltText = useCallback(() => {
    if (altTextResults.length === 0 || isApplyingAltText) return;
    const fd = new FormData();
    fd.set("intent", "bulk_apply_alt_text");
    fd.set("items", JSON.stringify(altTextResults));
    applyAltTextFetcher.submit(fd, { method: "post", action: "/app/bulk-generate" });
  }, [altTextResults, isApplyingAltText, applyAltTextFetcher]);

  // ── Combined Generate handler — fans out to whichever sections are selected ─
  const handleGenerateSelected = useCallback(() => {
    if (selectedSections.length === 0) return;
    setSectionsGenerated(selectedSections);

    // Description is skipped here once a run is already queued — re-clicking
    // Generate must never re-queue (and re-charge) an in-flight bulk run.
    if (
      selectedSections.includes("description") &&
      !isSubmitting &&
      !queuedBulkId &&
      canGenerateWithCredits
    ) {
      handleGenerateDescription();
    }
    if (
      selectedSections.includes("meta") &&
      metaResults.length === 0 &&
      !isGeneratingMeta &&
      canGenerateMetaWithCredits
    ) {
      handleGenerateMeta();
    }
    if (
      selectedSections.includes("alttext") &&
      altTextResults.length === 0 &&
      !isGeneratingAltText &&
      canGenerateAltTextWithCredits
    ) {
      handleGenerateAltText();
    }
  }, [
    selectedSections,
    isSubmitting,
    queuedBulkId,
    canGenerateWithCredits,
    handleGenerateDescription,
    metaResults.length,
    isGeneratingMeta,
    canGenerateMetaWithCredits,
    handleGenerateMeta,
    altTextResults.length,
    isGeneratingAltText,
    canGenerateAltTextWithCredits,
    handleGenerateAltText,
  ]);

  const kwList = parseKeywords(keywords);

  // ── Combined cost + busy state ─────────────────────────────────────────────
  const totalGenerateCost = useMemo(() => {
    let cost = 0;
    if (selectedSections.includes("description") && !queuedBulkId) cost += creditCost;
    if (selectedSections.includes("meta")) cost += metaCreditCost;
    if (selectedSections.includes("alttext")) cost += altTextCreditCost;
    return cost;
  }, [selectedSections, creditCost, metaCreditCost, altTextCreditCost, queuedBulkId]);

  const canGenerateSelected =
    selectedSections.length > 0 &&
    count > 0 &&
    hasCredits(creditsRemaining, totalGenerateCost);

  const isAltTextGenBusy = isGeneratingAltText;
  const isAnyGenerationBusy = isSubmitting || isGeneratingMeta || isAltTextGenBusy;

  const hasAnyApplyableResults =
    (selectedSections.includes("meta") && metaResults.length > 0) ||
    (selectedSections.includes("alttext") && altTextResults.length > 0);

  const handleApplySelected = useCallback(() => {
    if (selectedSections.includes("meta") && metaResults.length > 0 && !metaApplied) {
      handleApplyMeta();
    }
    if (selectedSections.includes("alttext") && altTextResults.length > 0 && !altTextApplied) {
      handleApplyAltText();
    }
  }, [
    selectedSections,
    metaResults.length,
    metaApplied,
    handleApplyMeta,
    altTextResults.length,
    altTextApplied,
    handleApplyAltText,
  ]);

  const isApplyingAny = isApplyingMeta || isApplyingAltText;

  // ── Whether there's anything left for the modal-level primary action to do (NEW) ──
  // Once description is queued, its own Generate/Apply lives entirely inside
  // BulkLiveResults. The modal's primary action now only concerns meta/alttext.
  // If description is the *only* selected section and it's queued, there's
  // nothing left to do here — hide the primary action entirely.
  const onlyDescriptionSelected =
    selectedSections.length === 1 && selectedSections[0] === "description";

  const primaryAction = (() => {
    if (queuedBulkId && onlyDescriptionSelected) {
      return undefined; // Apply All lives inside BulkLiveResults now
    }
    if (hasAnyApplyableResults) {
      return {
        content: isApplyingAny ? "Applying…" : "Apply to Shopify",
        onAction: handleApplySelected,
        loading: isApplyingAny,
        disabled: isApplyingAny || (metaApplied && altTextApplied),
      };
    }
    // Still-to-generate sections remain (meta/alttext), or nothing queued yet
    const remainingCost = totalGenerateCost;
    return {
      content: isAnyGenerationBusy
        ? "Generating…"
        : `✨ Generate${selectedSections.length ? ` (${formatCredits(remainingCost)} credits)` : ""}`,
      onAction: handleGenerateSelected,
      loading: isAnyGenerationBusy,
      disabled: isAnyGenerationBusy || !canGenerateSelected,
    };
  })();

  const hasStartedAnyRun = Boolean(queuedBulkId) || metaResults.length > 0 || altTextResults.length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="large"
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            Bulk Generate
          </Text>
          <Badge tone="info">{`${count} product${count !== 1 ? "s" : ""}`}</Badge>
        </InlineStack>
      }
      primaryAction={primaryAction}
      secondaryActions={[
        { content: hasStartedAnyRun ? "Close" : "Cancel", onAction: onClose },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">

          {/* ── Credits summary ── */}
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text as="p" variant="bodySm" tone="subdued">
                  Remaining credits
                </Text>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  {formatCredits(creditsRemaining)}
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* ── Section selector dropdown — locked once a run has started ── */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">What do you want to generate?</Text>

              <Popover
                active={sectionPopoverActive}
                onClose={() => setSectionPopoverActive(false)}
                fullWidth
                activator={
                  <Button
                    disclosure
                    fullWidth
                    textAlign="left"
                    disabled={hasStartedAnyRun}
                    onClick={() => setSectionPopoverActive((v) => !v)}
                  >
                    {selectedSections.length
                      ? selectedSections.map((s) => SECTION_LABELS[s]).join(", ")
                      : "Select sections"}
                  </Button>
                }
              >
                <Box padding="300">
                  <BlockStack gap="200">
                    <Checkbox
                      label={SECTION_LABELS.description}
                      checked={selectedSections.includes("description")}
                      onChange={(checked) => toggleSection("description", checked)}
                    />
                    <Checkbox
                      label={SECTION_LABELS.meta}
                      checked={selectedSections.includes("meta")}
                      onChange={(checked) => toggleSection("meta", checked)}
                    />
                    <Checkbox
                      label={SECTION_LABELS.alttext}
                      checked={selectedSections.includes("alttext")}
                      onChange={(checked) => toggleSection("alttext", checked)}
                    />
                  </BlockStack>
                </Box>
              </Popover>

              <InlineStack align="space-between">
                <Text as="p" variant="bodySm" tone="subdued">
                  Estimated credit cost
                </Text>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  {formatCredits(totalGenerateCost)} credit{totalGenerateCost === 1 ? "" : "s"}
                </Text>
              </InlineStack>

              {!canGenerateSelected && selectedSections.length > 0 && !queuedBulkId && (
                <Banner tone="critical" title="Not enough credits">
                  This selection needs {formatCredits(totalGenerateCost)} credits.
                </Banner>
              )}
            </BlockStack>
          </Card>

          {/* ══════════════════════════════════════════════
              SECTION: Description
              Two states: settings form (before queued) →
              live results (after queued). Never both.
          ══════════════════════════════════════════════ */}
          {selectedSections.includes("description") && (
            queuedBulkId ? (
              <BulkLiveResults
                bulkId={queuedBulkId}
                shopDomain={shopDomain}
              />
            ) : (
              <BlockStack gap="400">

                {/* Error banner (queueing failed) */}
                {result && !result.ok && (() => {
                  const isRateLimit =
                    result.code === "RATE_LIMIT_EXCEEDED" ||
                    result.code === "GLOBAL_LIMIT_REACHED";
                  return (
                    <Banner
                      tone={isRateLimit ? "warning" : "critical"}
                      title={
                        result.code === "INSUFFICIENT_CREDITS"
                          ? "Not enough credits"
                          : isRateLimit
                          ? "Generation unavailable"
                          : "Failed to queue jobs"
                      }
                    >
                      <Text as="p" variant="bodySm">
                        {result.error ?? "An unexpected error occurred. Please try again."}
                      </Text>
                    </Banner>
                  );
                })()}

                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Description credit cost
                      </Text>
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {formatCredits(creditCost)} credits
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </Card>

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

                    <BlockStack gap="200">
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
                        </div>
                        <div style={{ paddingTop: 22 }}>
                          <Button
                            onClick={handleSuggestKeywords}
                            loading={isSuggestingKeywords}
                            disabled={isSubmitting || count === 0 || !canSuggestWithCredits}
                            size="slim"
                          >
                            ✨ Suggest
                          </Button>
                        </div>
                      </InlineStack>

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

                      {keywordFetcher.data?.ok === false && (
                        <Text as="p" variant="bodySm" tone="critical">
                          Could not suggest keywords. Please try again.
                        </Text>
                      )}
                    </BlockStack>
                  </BlockStack>
                </Card>

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
            )
          )}

          {/* ══════════════════════════════════════════════
              SECTION: Meta title & description
              (unchanged — already inline/synchronous)
          ══════════════════════════════════════════════ */}
          {selectedSections.includes("meta") && (
            <BlockStack gap="400">

              {metaFetcher.data?.ok === false && (
                <Banner tone="critical" title="Generation failed">
                  {String(metaFetcher.data.error ?? "")}
                </Banner>
              )}

              {applyMetaFetcher.data?.ok === false && (
                <Banner tone="critical" title="Apply failed">
                  {String(applyMetaFetcher.data.error ?? "")}
                </Banner>
              )}

              {metaApplied && (
                <Banner tone="success" title="Applied to Shopify">
                  <Text as="p" variant="bodySm">
                    Meta titles and descriptions are now live on all {metaResults.length} products.
                  </Text>
                </Banner>
              )}

              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Meta credit cost ({count} products × {formatCredits(CREDIT_COSTS.metaGeneration)})
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(metaCreditCost)} credits
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              {metaResults.length === 0 ? (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Generate meta for all products</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      AI will generate an SEO-optimised meta title and description for each of the {count} selected products independently.
                    </Text>
                    {isGeneratingMeta && (
                      <InlineStack gap="300" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="p" tone="subdued">Generating meta for {count} products…</Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              ) : (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Generated meta — {metaResults.length} product{metaResults.length !== 1 ? "s" : ""}
                  </Text>
                  {metaResults.map((r, idx) => (
                    <Card key={r.productId}>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">
                          Product {idx + 1}
                        </Text>
                        <div
                          style={{
                            padding: 14,
                            background: "#fff",
                            border: "1px solid #dadce0",
                            borderRadius: 8,
                            fontFamily: "arial, sans-serif",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 16,
                              color: "#1a0dab",
                              marginBottom: 3,
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {r.meta_title}
                          </div>
                          <div style={{ fontSize: 12, color: "#006621", marginBottom: 3 }}>
                            yourstore.myshopify.com › products
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              color: "#545454",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {r.meta_description}
                          </div>
                        </div>
                        <InlineStack gap="300">
                          <Text as="p" variant="bodySm" tone="subdued">
                            Title: {r.meta_title.length}/60 chars
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Description: {r.meta_description.length}/155 chars
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  ))}
                </BlockStack>
              )}

            </BlockStack>
          )}

          {/* ══════════════════════════════════════════════
              SECTION: Image alt text
              (unchanged — already inline/synchronous)
          ══════════════════════════════════════════════ */}
          {selectedSections.includes("alttext") && (
            <BlockStack gap="400">

              {altTextFetcher.data?.ok === false && (
                <Banner tone="critical" title="Generation failed">
                  {String(altTextFetcher.data.error ?? "")}
                </Banner>
              )}

              {applyAltTextFetcher.data?.ok === false && (
                <Banner tone="critical" title="Apply failed">
                  {String(applyAltTextFetcher.data.error ?? "")}
                </Banner>
              )}

              {altTextApplied && (
                <Banner tone="success" title="Applied to Shopify">
                  <Text as="p" variant="bodySm">
                    Alt text has been applied to {altTextResults.length} image{altTextResults.length !== 1 ? "s" : ""} across all selected products.
                  </Text>
                </Banner>
              )}

              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Estimated alt text credit cost (per image across {count} products)
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(altTextCreditCost)}+ credits
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Exact cost depends on the number of images per product. You will only be charged for images that are processed.
                  </Text>
                </BlockStack>
              </Card>

              {altTextResults.length === 0 ? (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Generate alt text for all product images</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      AI will generate accessible, SEO-friendly alt text for every image across all {count} selected products.
                    </Text>
                    {isGeneratingAltText && (
                      <InlineStack gap="300" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="p" tone="subdued">Generating alt text for {count} products…</Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              ) : (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Generated alt text — {altTextResults.length} image{altTextResults.length !== 1 ? "s" : ""}
                  </Text>
                  {altTextResults.slice(0, 10).map((r, idx) => (
                    <div
                      key={`${r.productId}-${r.imageId}`}
                      style={{
                        padding: "10px 14px",
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                      }}
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Image {idx + 1}
                        </Text>
                        <Text as="p" variant="bodySm">{r.altText}</Text>
                        <Text
                          as="p"
                          variant="bodySm"
                          tone={r.altText.length > 125 ? "critical" : "subdued"}
                        >
                          {r.altText.length}/125 chars
                        </Text>
                      </BlockStack>
                    </div>
                  ))}
                  {altTextResults.length > 10 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      …and {altTextResults.length - 10} more images. All will be applied when you click Apply.
                    </Text>
                  )}
                </BlockStack>
              )}

            </BlockStack>
          )}

          {selectedSections.length === 0 && (
            <Card>
              <Box padding="400">
                <Text as="p" tone="subdued" alignment="center">
                  Select at least one section above to get started.
                </Text>
              </Box>
            </Card>
          )}

        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}