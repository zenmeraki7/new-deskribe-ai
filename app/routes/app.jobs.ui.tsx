// FILE: app/routes/app.jobs.ui.tsx
import React, { useCallback, useEffect, useMemo, useRef } from "react";
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
// JobRow sub-component — isolated fetcher per row prevents cross-row spinners
// ---------------------------------------------------------------------------

interface JobRowProps {
  job: JobRow;
  index: number;
}

function JobTableRow({ job, index }: JobRowProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; alreadyQueued?: boolean }>();
  const isSubmitting = fetcher.state !== "idle";
  const { label, tone } = statusBadge(job.status);

  const handleCancel = () => {
    const fd = new FormData();
    fd.set("intent", "cancel");
    fd.set("jobId", job.id);
    fetcher.submit(fd, { method: "post" });
  };

  const handleRetry = () => {
    const fd = new FormData();
    fd.set("intent", "retry");
    fd.set("jobId", job.id);
    fetcher.submit(fd, { method: "post" });
  };

  const displayName = job.productTitle ?? job.productId;
  const updatedDate = safeDateLabel(job.updatedAt);
  const progress = clampProgress(job.progress);

  const rowError =
    fetcher.data && fetcher.data.ok === false ? fetcher.data.error ?? "Action failed" : null;

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
          {job.status === "PENDING" && fetcher.data?.alreadyQueued && (
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
        <InlineStack gap="200" wrap>
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

  const isCancellingAll = cancelAllFetcher.state !== "idle";
  const cancelAllResult = cancelAllFetcher.data;

  const isOnFirstPage = !isUuidV4(params.get("cursor"));
  const isRevalidating = revalidator.state !== "idle";

  // -------------------------------------------------------------------------
  // Live auto-refresh with jitter + tab visibility + abort-safe scheduling.
  // Prevents timer leaks and synchronized spikes across merchants.
  // -------------------------------------------------------------------------

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // Always clear any existing timer when deps change/unmount.
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!hasActiveJobs) return;

    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;

      const jitter = 0.2; // ±20%
      const delta = POLL_INTERVAL_MS * jitter;
      const ms = Math.max(
        750,
        Math.floor(POLL_INTERVAL_MS + (Math.random() * 2 - 1) * delta),
      );

      timerRef.current = window.setTimeout(tick, ms);
    };

    const tick = () => {
      if (stopped) return;

      // Pause polling when tab is hidden (reduces load).
      if (typeof document !== "undefined" && document.hidden) {
        scheduleNext();
        return;
      }

      // Avoid stacking revalidations.
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
  // Pagination (cursor-based; only accept valid UUID cursors)
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
              {/* Optional: small sticky hint row (cheap UI guardrails) */}
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
                  <JobTableRow key={job.id} job={job} index={idx} />
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
    </Page>
  );
}
