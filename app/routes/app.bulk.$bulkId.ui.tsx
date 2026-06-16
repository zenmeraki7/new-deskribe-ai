// FILE: app/routes/app.bulk.$bulkId.ui.tsx
//
// UI for /app/bulk/:bulkId — review & apply bulk generation results.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Spinner,
  Box,
  Divider,
  ProgressBar,
  Tooltip,
  EmptyState,
  Modal,
  Tag,
} from "@shopify/polaris";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "@remix-run/react";
import type { BulkJobItem, BulkLoaderData } from "./app.bulk.$bulkId";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_MS = 4000;
const JITTER = 0.2;

function scheduleMs() {
  const delta = POLL_MS * JITTER;
  return Math.max(1000, Math.floor(POLL_MS + (Math.random() * 2 - 1) * delta));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: string): {
  label: string;
  tone: "success" | "attention" | "critical" | "info" | "warning" | undefined;
} {
  switch (status) {
    case "COMPLETED":
      return { label: "Completed", tone: "success" };
    case "PENDING":
      return { label: "Pending", tone: "attention" };
    case "PROCESSING":
      return { label: "Processing", tone: "info" };
    case "FAILED":
      return { label: "Failed", tone: "critical" };
    case "CANCELLED":
      return { label: "Cancelled", tone: "warning" };
    default:
      return { label: status, tone: undefined };
  }
}

function numericProductId(gid: string) {
  return gid.split("/").pop() ?? gid;
}

// ── Preview Modal ─────────────────────────────────────────────────────────────

interface PreviewModalProps {
  job: BulkJobItem | null;
  open: boolean;
  onClose: () => void;
  onApply: (jobId: string) => void;
  isApplying: boolean;
  applySuccess: boolean;
  applyError: string | null;
  shopDomain: string;
}

function PreviewModal({
  job,
  open,
  onClose,
  onApply,
  isApplying,
  applySuccess,
  applyError,
  shopDomain,
}: PreviewModalProps) {
  if (!job) return null;

  const isApplied = job.appliedAt !== null || applySuccess;
  const canApply = job.status === "COMPLETED" && !isApplied && !isApplying;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            {job.productTitle}
          </Text>
          {isApplied && <Badge tone="success">Applied</Badge>}
        </InlineStack>
      }
      primaryAction={
        canApply
          ? {
              content: isApplying ? "Applying…" : "Apply to Shopify",
              onAction: () => onApply(job.id),
              loading: isApplying,
              disabled: isApplying,
            }
          : undefined
      }
      secondaryActions={[
        {
          content: "Open product editor",
          url: `/app/products/${numericProductId(job.productId)}`,
        },
        { content: "Close", onAction: onClose },
      ]}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="400">
          {applyError && (
            <Banner tone="critical" title="Apply failed">
              {applyError}
            </Banner>
          )}
          {applySuccess && (
            <Banner tone="success" title="Applied to Shopify">
              This description is now live on the product.
            </Banner>
          )}
          {isApplied && !applySuccess && (
            <Banner tone="info" title="Already applied">
              This description was previously applied to Shopify.
            </Banner>
          )}

          {/* SEO Preview */}
          {(job.metaTitle || job.metaDescription) && (
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
                    {job.metaTitle || job.productTitle}
                  </div>
                  <div
                    style={{ fontSize: 13, color: "#006621", marginBottom: 4 }}
                  >
                    {shopDomain} › products
                  </div>
                  <div
                    style={
                      {
                        fontSize: 14,
                        color: "#545454",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      } as any
                    }
                  >
                    {job.metaDescription}
                  </div>
                </div>

                {job.keywords.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {job.keywords.slice(0, 20).map((kw) => (
                      <Badge key={kw} tone="info">
                        {kw}
                      </Badge>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          )}

          {/* Description preview */}
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Generated Description
              </Text>
              {job.bodyHtml ? (
                <div
                  style={{
                    border: "1px solid #e1e3e5",
                    borderRadius: 8,
                    padding: "16px 20px",
                    background: "#fafbfb",
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: "#202223",
                    maxHeight: 400,
                    overflowY: "auto",
                  }}
                  dangerouslySetInnerHTML={{ __html: job.bodyHtml }}
                />
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  No description generated.
                </Text>
              )}
            </BlockStack>
          </Card>

          {/* Settings */}
          <InlineStack gap="200" wrap>
            {job.vibe && <Tag>Style: {job.vibe}</Tag>}
            {job.format && <Tag>Format: {job.format}</Tag>}
          </InlineStack>

          {/* Social caption */}
          {job.socialCaption && (
            <Card>
              <BlockStack gap="100">
                <Text
                  as="p"
                  variant="bodySm"
                  tone="subdued"
                  fontWeight="semibold"
                >
                  Instagram caption:
                </Text>
                <Text as="p" variant="bodySm">
                  {job.socialCaption}
                </Text>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Job Card ──────────────────────────────────────────────────────────────────

interface JobCardProps {
  job: BulkJobItem;
  onPreview: (job: BulkJobItem) => void;
  onApplyOne: (jobId: string) => void;
  onRetryOne: (jobId: string) => void;
  isApplying: boolean;
  isRetrying: boolean;
  applySucceeded: boolean;
}

function JobCard({
  job,
  onPreview,
  onApplyOne,
  onRetryOne,
  isApplying,
  isRetrying,
  applySucceeded,
}: JobCardProps) {
  const { label, tone } = statusBadge(job.status);
  const isApplied = job.appliedAt !== null || applySucceeded;
  const isCompleted = job.status === "COMPLETED";
  const isFailed = job.status === "FAILED";
  const isInFlight = job.status === "PENDING" || job.status === "PROCESSING";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: 10,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        transition: "box-shadow 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 4px 12px rgba(0,0,0,0.08)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 1px 3px rgba(0,0,0,0.04)";
      }}
    >
      {/* Header row */}
      <InlineStack align="space-between" blockAlign="start" wrap={false}>
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {job.productTitle}
          </Text>
          <InlineStack gap="150" blockAlign="center">
            <Badge tone={tone}>{label}</Badge>
            {isApplied && <Badge tone="success">✓ Applied</Badge>}
            {isInFlight && <Spinner size="small" />}
          </InlineStack>
        </BlockStack>
      </InlineStack>

      {/* Description snippet */}
      {isCompleted && job.bodyHtml && (
        <div
          style={
            {
              fontSize: 13,
              color: "#6d7175",
              lineHeight: 1.5,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
            } as any
          }
          dangerouslySetInnerHTML={{ __html: job.bodyHtml }}
        />
      )}

      {/* Error */}
      {isFailed && job.errorMessage && (
        <Box padding="200" background="bg-surface-critical" borderRadius="200">
          <Text as="p" variant="bodySm" tone="critical">
            {job.errorMessage.length > 120
              ? `${job.errorMessage.slice(0, 120)}…`
              : job.errorMessage}
          </Text>
        </Box>
      )}

      {/* Pending placeholder */}
      {isInFlight && (
        <Text as="p" variant="bodySm" tone="subdued">
          Generating description…
        </Text>
      )}

      {/* Actions */}
      <InlineStack gap="200" wrap>
        {isCompleted && (
          <Button size="slim" onClick={() => onPreview(job)}>
            Preview
          </Button>
        )}
        {isCompleted && !isApplied && (
          <Button
            size="slim"
            variant="primary"
            onClick={() => onApplyOne(job.id)}
            loading={isApplying}
            disabled={isApplying}
          >
            Apply to Shopify
          </Button>
        )}
        {isFailed && (
          <Button
            size="slim"
            onClick={() => onRetryOne(job.id)}
            loading={isRetrying}
            disabled={isRetrying}
          >
            Retry
          </Button>
        )}
        {isCompleted && (
          <Button
            size="slim"
            variant="plain"
            url={`/app/products/${numericProductId(job.productId)}`}
          >
            Full editor ↗
          </Button>
        )}
      </InlineStack>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BulkReviewPage() {
  const data = useLoaderData<BulkLoaderData>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const {
    bulkId,
    jobs,
    totalCount,
    completedCount,
    pendingCount,
    failedCount,
    appliedCount,
    shopDomain,
  } = data;

  // Per-job fetchers: apply_one + retry_one
  // We track them in a map by jobId so each card has its own loading state.
  const applyFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    intent?: string;
  }>();
  const applyAllFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    succeeded?: number;
    failed?: number;
    total?: number;
  }>();
  const retryFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    jobId?: string;
  }>();

  // Preview modal state
  const [previewJob, setPreviewJob] = useState<BulkJobItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Track which jobId is being acted on (for per-card loading indicators)
  const [actingJobId, setActingJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

  // Apply success set (for immediate UI update without revalidation delay)
  const [appliedJobIds, setAppliedJobIds] = useState<Set<string>>(new Set());

  // ── Auto-poll while jobs are still in flight ─────────────────────────────
  const timerRef = useRef<number | null>(null);
  const hasInFlight = pendingCount > 0;

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (!hasInFlight) return;

    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }
      if (revalidator.state === "idle") revalidator.revalidate();
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };
    timerRef.current = window.setTimeout(tick, scheduleMs());

    return () => {
      stopped = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [hasInFlight, revalidator]);

  // ── Handle apply_one result ───────────────────────────────────────────────
  useEffect(() => {
    if (!applyFetcher.data) return;
    if (applyFetcher.data.ok && applyFetcher.data.intent === "apply_one") {
      const fd = applyFetcher.data as any;
      if (fd.jobId) setAppliedJobIds((prev) => new Set([...prev, fd.jobId]));
      setActingJobId(null);
    }
    if (!applyFetcher.data.ok) setActingJobId(null);
  }, [applyFetcher.data]);

  // ── Handle apply_all result ──────────────────────────────────────────────
  useEffect(() => {
    if (applyAllFetcher.data?.ok) {
      revalidator.revalidate();
    }
  }, [applyAllFetcher.data]);

  // ── Handle retry_one result ──────────────────────────────────────────────
  useEffect(() => {
    if (!retryFetcher.data) return;
    setRetryingJobId(null);
    if (retryFetcher.data.ok) revalidator.revalidate();
  }, [retryFetcher.data]);

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleApplyOne = useCallback(
    (jobId: string) => {
      setActingJobId(jobId);
      const fd = new FormData();
      fd.set("intent", "apply_one");
      fd.set("jobId", jobId);
      applyFetcher.submit(fd, { method: "post" });
    },
    [applyFetcher],
  );

  const handleApplyAll = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "apply_all");
    applyAllFetcher.submit(fd, { method: "post" });
  }, [applyAllFetcher]);

  const handleRetryOne = useCallback(
    (jobId: string) => {
      setRetryingJobId(jobId);
      const fd = new FormData();
      fd.set("intent", "retry_one");
      fd.set("jobId", jobId);
      retryFetcher.submit(fd, { method: "post" });
    },
    [retryFetcher],
  );

  const handlePreview = useCallback((job: BulkJobItem) => {
    setPreviewJob(job);
    setPreviewOpen(true);
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────
  const percentDone =
    totalCount === 0
      ? 100
      : Math.round(((completedCount + failedCount) / totalCount) * 100);

  const unappliedCompleted = jobs.filter(
    (j) =>
      j.status === "COMPLETED" &&
      j.appliedAt === null &&
      !appliedJobIds.has(j.id),
  );
  const canApplyAll =
    unappliedCompleted.length > 0 && applyAllFetcher.state === "idle";
  const isApplyingAll = applyAllFetcher.state !== "idle";

  const applyAllResult = applyAllFetcher.data;

  // For the preview modal
  const previewJobCurrent = previewJob
    ? (jobs.find((j) => j.id === previewJob.id) ?? previewJob)
    : null;

  const previewApplyResult =
    applyFetcher.data?.intent === "apply_one" ? applyFetcher.data : null;

  return (
    <Page
      title="Bulk Review"
      subtitle={`${totalCount} products · Bulk run ${bulkId.slice(0, 8)}…`}
      backAction={{ content: "History", url: "/app/jobs" }}
      primaryAction={
        canApplyAll
          ? {
              content: isApplyingAll
                ? "Applying…"
                : `Apply All (${unappliedCompleted.length})`,
              onAction: handleApplyAll,
              loading: isApplyingAll,
              disabled: isApplyingAll,
            }
          : undefined
      }
    >
      <BlockStack gap="500">
        {/* ── Apply All result banner ──────────────────────────────────── */}
        {applyAllResult?.ok && (
          <Banner
            tone={applyAllResult.failed! > 0 ? "warning" : "success"}
            title={
              applyAllResult.failed! > 0
                ? `Applied ${applyAllResult.succeeded} of ${applyAllResult.total} — ${applyAllResult.failed} failed`
                : `All ${applyAllResult.succeeded} description${applyAllResult.succeeded !== 1 ? "s" : ""} applied to Shopify`
            }
            onDismiss={() => revalidator.revalidate()}
          />
        )}
        {applyAllResult && !applyAllResult.ok && (
          <Banner tone="critical" title="Apply All failed">
            {applyAllResult.error ?? "An unexpected error occurred."}
          </Banner>
        )}

        {/* ── Progress summary card ────────────────────────────────────── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Progress
              </Text>
              {hasInFlight && (
                <InlineStack gap="150" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Auto-refreshing…
                  </Text>
                </InlineStack>
              )}
            </InlineStack>

            <ProgressBar
              progress={percentDone}
              size="medium"
              tone={failedCount > 0 ? "critical" : "highlight"}
            />

            {/* Stat pills */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                {
                  label: "Total",
                  value: totalCount,
                  bg: "#f6f6f7",
                  color: "#202223",
                },
                {
                  label: "Completed",
                  value: completedCount,
                  bg: "#f0fdf4",
                  color: "#1a7f37",
                },
                {
                  label: "In Progress",
                  value: pendingCount,
                  bg: "#fff8e1",
                  color: "#916a00",
                },
                {
                  label: "Failed",
                  value: failedCount,
                  bg: "#fff5f5",
                  color: "#c0392b",
                },
                {
                  label: "Applied",
                  value: appliedCount + appliedJobIds.size,
                  bg: "#eff6ff",
                  color: "#2c6ecb",
                },
              ].map(({ label, value, bg, color }) => (
                <div
                  key={label}
                  style={{
                    background: bg,
                    borderRadius: 8,
                    padding: "8px 14px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    minWidth: 72,
                  }}
                >
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color,
                      lineHeight: 1,
                    }}
                  >
                    {value}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#6d7175",
                      marginTop: 2,
                      fontWeight: 500,
                    }}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </BlockStack>
        </Card>

        {/* ── Product cards grid ───────────────────────────────────────── */}
        {jobs.length === 0 ? (
          <EmptyState
            heading="No products in this bulk run"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>This bulk run has no associated jobs.</p>
          </EmptyState>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={
                  // Merge optimistic applied state
                  appliedJobIds.has(job.id)
                    ? { ...job, appliedAt: new Date().toISOString() }
                    : job
                }
                onPreview={handlePreview}
                onApplyOne={handleApplyOne}
                onRetryOne={handleRetryOne}
                isApplying={
                  actingJobId === job.id && applyFetcher.state !== "idle"
                }
                isRetrying={
                  retryingJobId === job.id && retryFetcher.state !== "idle"
                }
                applySucceeded={
                  appliedJobIds.has(job.id) ||
                  (applyFetcher.data?.ok === true && actingJobId === job.id)
                }
              />
            ))}
          </div>
        )}
      </BlockStack>

      {/* ── Preview Modal ─────────────────────────────────────────────── */}
      <PreviewModal
        job={previewJobCurrent}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        onApply={handleApplyOne}
        isApplying={
          previewJob !== null &&
          actingJobId === previewJob.id &&
          applyFetcher.state !== "idle"
        }
        applySuccess={
          previewJob !== null &&
          (appliedJobIds.has(previewJob.id) ||
            (applyFetcher.data?.ok === true &&
              (applyFetcher.data as any).jobId === previewJob.id))
        }
        applyError={
          previewJob !== null &&
          applyFetcher.data?.ok === false &&
          actingJobId === previewJob.id
            ? (applyFetcher.data.error ?? null)
            : null
        }
        shopDomain={shopDomain}
      />
    </Page>
  );
}
