// FILE: app/routes/app.jobs.ui.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  Button,
  InlineStack,
  BlockStack,
  Banner,
  Text,
  Tooltip,
  EmptyState,
  Spinner,
  Box,
  Modal,
  Divider,
  Tag,
} from "@shopify/polaris";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  useNavigate,
  Link,
} from "@remix-run/react";

import type { loader } from "./app.jobs.server";
import type { JobRow } from "./app.jobs.types";
import { clampProgress, statusBadge } from "./app.jobs.types";
import { POLL_INTERVAL_MS, UUID_RE } from "./app.jobs.constants";

// ---------------------------------------------------------------------------
// Helpers (UI-side)
// ---------------------------------------------------------------------------

function safeDateLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function safeShortError(msg: string, max = 80) {
  const s = typeof msg === "string" ? msg.trim() : "";
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function isUuidV4(x: string | null) {
  return !!x && UUID_RE.test(x);
}

// ---------------------------------------------------------------------------
// Job Detail Modal
// ---------------------------------------------------------------------------

interface JobDetailModalProps {
  job: JobRow | null;
  open: boolean;
  onClose: () => void;
}

function JobDetailModal({ job, open, onClose }: JobDetailModalProps) {
  const undoFetcher = useFetcher<{ ok: boolean; error?: string; restored?: boolean }>();
  const isUndoing = undoFetcher.state !== "idle";
  const undoResult = undoFetcher.data;

  if (!job) return null;

  const handleUndo = () => {
    const fd = new FormData();
    fd.set("intent", "undo");
    fd.set("jobId", job.id);
    undoFetcher.submit(fd, { method: "post" });
  };

  const { label, tone } = statusBadge(job.status);
  // Show Undo for any completed job not yet undone.
  // If no snapshot exists, the server clears the description to "".
  const canUndo = job.status === "COMPLETED" && !undoResult?.restored;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Job Details — ${job.productTitle ?? job.productId}`}
      primaryAction={
        canUndo
          ? {
              content: "↩ Undo Generation",
              onAction: handleUndo,
              loading: isUndoing,
              disabled: isUndoing,
              destructive: true,
            }
          : undefined
      }
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {undoResult?.ok && undoResult.restored && (
            <Banner tone="success" title="Description restored">
              The previous description has been restored to the product.
            </Banner>
          )}
          {undoResult && !undoResult.ok && (
            <Banner tone="critical" title="Undo failed">
              {undoResult.error ?? "Could not restore the previous description."}
            </Banner>
          )}

          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              Status:
            </Text>
            <Badge tone={tone}>{label}</Badge>
          </InlineStack>

          <Divider />

          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">
                Created:
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {safeDateLabel(job.createdAt)}
              </Text>
            </InlineStack>
            <InlineStack gap="200" wrap>
              <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">
                Last updated:
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {safeDateLabel(job.updatedAt)}
              </Text>
            </InlineStack>
          </BlockStack>

          <Divider />

          {(job.format || job.tone || job.costTokens > 0) && (
            <>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Generation settings
                </Text>
                <InlineStack gap="200" wrap>
                  {job.format && <Tag>Format: {job.format}</Tag>}
                  {job.tone && <Tag>Tone: {job.tone}</Tag>}
                  {job.costTokens > 0 && (
                    <Tag>{job.costTokens.toLocaleString()} tokens</Tag>
                  )}
                </InlineStack>
              </BlockStack>
              <Divider />
            </>
          )}

          {job.status === "FAILED" && job.errorMessage && (
            <>
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd" fontWeight="semibold" tone="critical">
                  Error
                </Text>
                <Box padding="300" background="bg-surface-critical-subdued" borderRadius="200">
                  <Text as="p" variant="bodySm" tone="critical">
                    {job.errorMessage}
                  </Text>
                </Box>
              </BlockStack>
              <Divider />
            </>
          )}

          {job.generatedDescription ? (
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Generated description
              </Text>
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
                borderWidth="025"
                borderColor="border"
              >
                <Text as="p" variant="bodySm">
                  {job.generatedDescription}
                </Text>
              </Box>
              {!undoResult?.restored && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {job.hasPreviousDescription
                    ? "A previous description is saved — Undo will restore it."
                    : "No snapshot saved — Undo will clear this description on the product."}
                </Text>
              )}
              {undoResult?.restored && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Previous description restored. Refresh the product to confirm.
                </Text>
              )}
            </BlockStack>
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">
              No generated description available yet.
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// JobRow sub-component — isolated fetcher per row prevents cross-row spinners
// ---------------------------------------------------------------------------

interface JobRowProps {
  job: JobRow;
  index: number;
  onViewDetails: (job: JobRow) => void;
}

function JobTableRow({ job, index, onViewDetails }: JobRowProps) {
  const actionFetcher = useFetcher<{ ok: boolean; error?: string; alreadyQueued?: boolean }>();
  const undoFetcher = useFetcher<{ ok: boolean; error?: string; restored?: boolean }>();

  const isSubmitting = actionFetcher.state !== "idle";
  const isUndoing = undoFetcher.state !== "idle";
  const hasUndone = undoFetcher.data?.ok === true;

  const { label, tone } = statusBadge(job.status);

  const handleCancel = () => {
    const fd = new FormData();
    fd.set("intent", "cancel");
    fd.set("jobId", job.id);
    actionFetcher.submit(fd, { method: "post" });
  };

  const handleRetry = () => {
    const fd = new FormData();
    fd.set("intent", "retry");
    fd.set("jobId", job.id);
    actionFetcher.submit(fd, { method: "post" });
  };

  const handleUndo = () => {
    const fd = new FormData();
    fd.set("intent", "undo");
    fd.set("jobId", job.id);
    undoFetcher.submit(fd, { method: "post" });
  };

  const displayName = job.productTitle ?? job.productId;
  const updatedDate = safeDateLabel(job.updatedAt);
  const progress = clampProgress(job.progress);

  // Undo is active (red) only for COMPLETED jobs that haven't been undone yet
  const canUndo = job.status === "COMPLETED" && !hasUndone && job.status !== "UNDONE";

  const rowError =
    actionFetcher.data && actionFetcher.data.ok === false
      ? (actionFetcher.data.error ?? "Action failed")
      : undoFetcher.data && undoFetcher.data.ok === false
        ? (undoFetcher.data.error ?? "Undo failed")
        : null;

  return (
    <IndexTable.Row id={job.id} key={job.id} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {displayName}
          </Text>
          {rowError ? (
            <Text as="span" variant="bodySm" tone="critical">
              {safeShortError(rowError, 120)}
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          {isSubmitting ? <Spinner size="small" /> : <Badge tone={tone}>{label}</Badge>}
          {job.status === "PROCESSING" && progress > 0 && (
            <Text as="span" variant="bodySm" tone="subdued">
              {progress}%
            </Text>
          )}
          {job.status === "PENDING" && actionFetcher.data?.alreadyQueued && (
            <Text as="span" variant="bodySm" tone="subdued">
              queued…
            </Text>
          )}
        </InlineStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {job.status === "FAILED" && job.errorMessage ? (
          <Tooltip content={job.errorMessage}>
            <Text as="span" variant="bodySm" tone="critical">
              {safeShortError(job.errorMessage, 60)}
            </Text>
          </Tooltip>
        ) : job.costTokens > 0 ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {job.costTokens.toLocaleString()} tokens
          </Text>
        ) : (
          <Text as="span" variant="bodySm" tone="subdued">
            —
          </Text>
        )}
      </IndexTable.Cell>

      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {updatedDate}
        </Text>
      </IndexTable.Cell>

      <IndexTable.Cell>
        <InlineStack gap="200" wrap blockAlign="center">

          {/* Retry — FAILED only */}
          {job.status === "FAILED" && (
            <Button
              size="slim"
              onClick={handleRetry}
              loading={isSubmitting}
              disabled={isSubmitting}
              accessibilityLabel={`Retry job for ${displayName}`}
            >
              Retry
            </Button>
          )}

          {/* Cancel — PENDING only */}
          {job.status === "PENDING" && (
            <Button
              size="slim"
              tone="critical"
              onClick={handleCancel}
              loading={isSubmitting}
              disabled={isSubmitting}
              accessibilityLabel={`Cancel job for ${displayName}`}
            >
              Cancel
            </Button>
          )}

          {/* View — always visible, opens detail modal */}
          <Button
            size="slim"
            onClick={() => onViewDetails(job)}
            accessibilityLabel={`View details for ${displayName}`}
          >
            View
          </Button>

          {/* Undo Edit — always shown; active (red) only for COMPLETED */}
          <Button
            size="slim"
            tone={canUndo ? "critical" : undefined}
            onClick={canUndo ? handleUndo : undefined}
            loading={isUndoing}
            disabled={!canUndo || isUndoing}
            accessibilityLabel={
              canUndo
                ? `Undo generated description for ${displayName}`
                : "Undo not available"
            }
          >
            Undo Edit
          </Button>

        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

// ---------------------------------------------------------------------------
// Main route component
// ---------------------------------------------------------------------------

export default function JobsRoute() {
  const { jobs, hasActiveJobs, hasNextPage, nextCursor, totalPending } =
    useLoaderData<typeof loader>();

  const revalidator = useRevalidator();
  const cancelAllFetcher = useFetcher<{ ok: boolean; cancelled?: number; error?: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  // Modal state
  const [selectedJob, setSelectedJob] = useState<JobRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const handleViewDetails = useCallback((job: JobRow) => {
    setSelectedJob(job);
    setModalOpen(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  const isCancellingAll = cancelAllFetcher.state !== "idle";
  const cancelAllResult = cancelAllFetcher.data;

  const isOnFirstPage = !isUuidV4(params.get("cursor"));
  const isRevalidating = revalidator.state !== "idle";

  // -------------------------------------------------------------------------
  // Live auto-refresh with jitter + tab visibility + abort-safe scheduling.
  // -------------------------------------------------------------------------

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!hasActiveJobs) return;

    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;
      const jitter = 0.2;
      const delta = POLL_INTERVAL_MS * jitter;
      const ms = Math.max(750, Math.floor(POLL_INTERVAL_MS + (Math.random() * 2 - 1) * delta));
      timerRef.current = window.setTimeout(tick, ms);
    };

    const tick = () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.hidden) {
        scheduleNext();
        return;
      }
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
      scheduleNext();
    };

    scheduleNext();

    return () => {
      stopped = true;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [hasActiveJobs, revalidator]);

  // -------------------------------------------------------------------------
  // Cancel All
  // -------------------------------------------------------------------------

  const handleCancelAll = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "cancel_all");
    cancelAllFetcher.submit(fd, { method: "post" });
  }, [cancelAllFetcher]);

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  const handleNext = useCallback(() => {
    if (!nextCursor || !UUID_RE.test(nextCursor)) return;
    const next = new URLSearchParams(params);
    next.set("cursor", nextCursor);
    navigate(`?${next.toString()}`);
  }, [nextCursor, params, navigate]);

  const handlePrev = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    navigate(`?${next.toString()}`);
  }, [params, navigate]);

  const autoRefreshLabel = useMemo(() => {
    if (!hasActiveJobs) return null;
    return `Auto-refreshing about every ${Math.round(POLL_INTERVAL_MS / 1000)}s…`;
  }, [hasActiveJobs]);

  return (
    <Page title="Generation Queue" fullWidth>
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Job Monitor
              </Text>
              <InlineStack gap="200" blockAlign="center">
                {isRevalidating && <Spinner size="small" />}
                {autoRefreshLabel && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {autoRefreshLabel}
                  </Text>
                )}
              </InlineStack>
            </BlockStack>

            <InlineStack gap="300" wrap>
              {totalPending > 0 && (
                <Button
                  tone="critical"
                  onClick={handleCancelAll}
                  loading={isCancellingAll}
                  disabled={isCancellingAll}
                  accessibilityLabel={`Cancel all pending jobs (${totalPending})`}
                >
                  {`⛔ Cancel All Pending (${totalPending})`}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
        </Card>

        {cancelAllResult?.ok && typeof cancelAllResult.cancelled === "number" && (
          <Banner tone="success" title="Bulk cancellation complete">
            {cancelAllResult.cancelled > 0
              ? `${cancelAllResult.cancelled} pending job(s) cancelled.`
              : "No pending jobs were found."}
          </Banner>
        )}

        {cancelAllResult && !cancelAllResult.ok && (
          <Banner tone="critical" title="Cancellation failed">
            {cancelAllResult.error ?? "An unknown error occurred."}
          </Banner>
        )}

        <Card padding="0">
          {jobs.length === 0 ? (
            <EmptyState
              heading="No jobs yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Generate descriptions from the <Link to="/app/products">Products</Link> page to see jobs here.
              </p>
            </EmptyState>
          ) : (
            <>
              <Box padding="300" borderBlockEndWidth="1px" borderColor="border">
                <Text as="p" variant="bodySm" tone="subdued">
                  Jobs are shop-scoped and actions are idempotent. If you double-click Retry/Cancel, it will
                  only apply once.
                </Text>
              </Box>

              <IndexTable
                resourceName={{ singular: "job", plural: "jobs" }}
                itemCount={jobs.length}
                headings={[
                  { title: "Product" },
                  { title: "Status" },
                  { title: "Details" },
                  { title: "Updated" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {jobs.map((job, idx) => (
                  <JobTableRow
                    key={job.id}
                    job={job}
                    index={idx}
                    onViewDetails={handleViewDetails}
                  />
                ))}
              </IndexTable>
            </>
          )}
        </Card>

        {(hasNextPage || !isOnFirstPage) && (
          <InlineStack align="space-between">
            <Button disabled={isOnFirstPage} onClick={handlePrev}>
              ← Newer
            </Button>
            <Button disabled={!hasNextPage} onClick={handleNext}>
              Older →
            </Button>
          </InlineStack>
        )}
      </BlockStack>

      {/* Modal lives outside the table to avoid DOM nesting issues */}
      <JobDetailModal
        job={selectedJob}
        open={modalOpen}
        onClose={handleModalClose}
      />
    </Page>
  );
}