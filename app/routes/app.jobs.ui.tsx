// FILE: app/routes/app.jobs.ui.tsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  Tabs,
} from "@shopify/polaris";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  useNavigate,
  Link,
} from "@remix-run/react";

import type { JobRow, LoaderData } from "./app.jobs.types";
import { clampProgress, statusBadge } from "./app.jobs.types";
import { POLL_INTERVAL_MS, UUID_RE } from "./app.jobs.constants";

// ---------------------------------------------------------------------------
// Helpers
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
  shopDomain: string;
}

function JobDetailModal({ job, open, onClose, shopDomain }: JobDetailModalProps) {
  const undoFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    restored?: boolean;
  }>();
  const applyFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    applied?: boolean;
    kind?: string;
  }>();

  const isUndoing = undoFetcher.state !== "idle";
  const isApplying = applyFetcher.state !== "idle";
  const undoResult = undoFetcher.data;
  const applyResult = applyFetcher.data;

  if (!job) return null;

  const handleUndo = () => {
    const fd = new FormData();
    fd.set("intent", "undo");
    fd.set("jobId", job.id);
    undoFetcher.submit(fd, { method: "post" });
  };

  const handleApply = () => {
    const numericId = job.productId.split("/").pop();
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("jobId", job.id);
    applyFetcher.submit(fd, {
      method: "post",
      action: `/app/products/${numericId}`,
    });
  };

  const { label, tone } = statusBadge(job.status);
  const applySuccess =
    applyResult?.ok === true && applyResult?.applied === true;
  const canApply = job.status === "COMPLETED" && !applySuccess && !isApplying;
  const canUndo = job.status === "COMPLETED" && !undoResult?.restored;

  // draftBodyHtml is the server-sanitized body_html from result JSON.
  // Falls back to generatedDescription (set after apply).
  const draftHtml =
    (job as any).draftBodyHtml || job.generatedDescription || "";
  const metaTitle = (job as any).metaTitle || "";
  const metaDescription = (job as any).metaDescription || "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            {job.productTitle ?? job.productId}
          </Text>
          {applySuccess && <Badge tone="success">Applied</Badge>}
        </InlineStack>
      }
      primaryAction={
        canApply
          ? {
              content: isApplying ? "Applying…" : "Apply to Shopify",
              onAction: handleApply,
              loading: isApplying,
              disabled: isApplying,
            }
          : undefined
      }
      secondaryActions={[
        ...(canUndo
          ? [
              {
                content: "↩ Undo",
                onAction: handleUndo,
                loading: isUndoing,
                disabled: isUndoing,
                destructive: true,
              },
            ]
          : []),
        { content: "Close", onAction: onClose },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {/* Banners */}
          {undoResult?.ok && undoResult.restored && (
            <Banner tone="success" title="Description restored">
              The previous description has been restored to the product.
            </Banner>
          )}
          {undoResult && !undoResult.ok && (
            <Banner tone="critical" title="Undo failed">
              {undoResult.error ??
                "Could not restore the previous description."}
            </Banner>
          )}
          {applySuccess && (
            <Banner tone="success" title="Applied to Shopify">
              This description is now live on the product.
            </Banner>
          )}
          {applyResult && !applyResult.ok && (
            <Banner tone="critical" title="Apply failed">
              {applyResult.error ?? "An unexpected error occurred."}
            </Banner>
          )}

          {/* Status + timestamps */}
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              Status:
            </Text>
            <Badge tone={tone}>{label}</Badge>
          </InlineStack>

          <Divider />

          <BlockStack gap="200">
            <InlineStack gap="200" wrap>
              <Text
                as="span"
                variant="bodySm"
                tone="subdued"
                fontWeight="semibold"
              >
                Created:
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {safeDateLabel(job.createdAt)}
              </Text>
            </InlineStack>
            <InlineStack gap="200" wrap>
              <Text
                as="span"
                variant="bodySm"
                tone="subdued"
                fontWeight="semibold"
              >
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
                <Text
                  as="p"
                  variant="bodyMd"
                  fontWeight="semibold"
                  tone="critical"
                >
                  Error
                </Text>
                <Box
                  padding="300"
                  background="bg-surface-critical"
                  borderRadius="200"
                >
                  <Text as="p" variant="bodySm" tone="critical">
                    {job.errorMessage}
                  </Text>
                </Box>
              </BlockStack>
              <Divider />
            </>
          )}

          {/* SEO preview — shown when meta is available */}
          {job.status === "COMPLETED" && (metaTitle || metaDescription) && (
            <>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
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
                    {metaTitle || job.productTitle}
                  </div>
                  <div style={{ fontSize: 13, color: "#006621", marginBottom: 4 }}>
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
                    {metaDescription}
                  </div>
                </div>
              </BlockStack>
              <Divider />
            </>
          )}

          {/* Generated description */}
          {draftHtml ? (
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
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "#202223",
                    maxHeight: 320,
                    overflowY: "auto",
                  }}
                  dangerouslySetInnerHTML={{ __html: draftHtml }}
                />
              </Box>
              {canUndo && !undoResult?.restored && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {job.hasPreviousDescription
                    ? "A previous description is saved — Undo will restore it."
                    : "No snapshot saved — Undo will clear this description on the product."}
                </Text>
              )}
            </BlockStack>
          ) : job.status === "COMPLETED" ? (
            <Banner
              tone="warning"
              title="Description not available in this view"
            >
              Open the full product editor to preview and apply the generated
              description.
            </Banner>
          ) : (
            <Text as="p" variant="bodySm" tone="subdued">
              No generated description available yet.
            </Text>
          )}

          {job.status === "COMPLETED" && (
            <InlineStack>
              <Button
                variant="plain"
                url={`/app/products/${job.productId.split("/").pop()}`}
              >
                Open full editor  ↗
              </Button>
            </InlineStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Individual job row
// ---------------------------------------------------------------------------

interface JobRowProps {
  job: JobRow;
  index: number;
  onViewDetails: (job: JobRow) => void;
}

function JobTableRow({ job, index, onViewDetails }: JobRowProps) {
  const actionFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    alreadyQueued?: boolean;
  }>();
  const undoFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    restored?: boolean;
  }>();

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
  const canUndo = job.status === "COMPLETED" && !hasUndone;

  const rowError =
    actionFetcher.data?.ok === false
      ? (actionFetcher.data.error ?? "Action failed")
      : undoFetcher.data?.ok === false
        ? (undoFetcher.data.error ?? "Undo failed")
        : null;

  return (
    <IndexTable.Row id={job.id} key={job.id} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            <span
              style={{
                display: "block",
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </span>
          </Text>
          {rowError && (
            <Text as="span" variant="bodySm" tone="critical">
              {safeShortError(rowError, 120)}
            </Text>
          )}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          {isSubmitting ? (
            <Spinner size="small" />
          ) : (
            <Badge tone={tone}>{label}</Badge>
          )}
          {job.status === "PROCESSING" && progress > 0 && (
            <Text as="span" variant="bodySm" tone="subdued">
              {progress}%
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
          {job.status === "FAILED" && (
            <Button
              size="slim"
              onClick={handleRetry}
              loading={isSubmitting}
              disabled={isSubmitting}
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
            >
              Cancel
            </Button>
          )}
          <Button size="slim" onClick={() => onViewDetails(job)}>
            View
          </Button>
          <Button
            size="slim"
            tone={canUndo ? "critical" : undefined}
            onClick={canUndo ? handleUndo : undefined}
            loading={isUndoing}
            disabled={!canUndo || isUndoing}
          >
            Undo Edit
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

// ---------------------------------------------------------------------------
// Bulk Runs tab
// ---------------------------------------------------------------------------

interface BulkRun {
  bulkId: string;
  jobs: JobRow[];
  completedCount: number;
  pendingCount: number;
  failedCount: number;
  totalCount: number;
  latestUpdatedAt: string;
}

function buildBulkRuns(jobs: JobRow[]): BulkRun[] {
  const map = new Map<string, JobRow[]>();
  for (const job of jobs) {
    if (!job.bulkId) continue;
    const existing = map.get(job.bulkId) ?? [];
    existing.push(job);
    map.set(job.bulkId, existing);
  }
  return Array.from(map.entries())
    .map(([bulkId, runJobs]) => ({
      bulkId,
      jobs: runJobs,
      totalCount: runJobs.length,
      completedCount: runJobs.filter((j) => j.status === "COMPLETED").length,
      pendingCount: runJobs.filter(
        (j) => j.status === "PENDING" || j.status === "PROCESSING",
      ).length,
      failedCount: runJobs.filter((j) => j.status === "FAILED").length,
      latestUpdatedAt: runJobs.reduce(
        (latest, j) => (j.updatedAt > latest ? j.updatedAt : latest),
        runJobs[0].updatedAt,
      ),
    }))
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

function BulkRunRow({ run, index }: { run: BulkRun; index: number }) {
  const navigate = useNavigate();
  const { completedCount, pendingCount, failedCount, totalCount, bulkId } = run;
  const percentDone =
    totalCount === 0
      ? 100
      : Math.round(((completedCount + failedCount) / totalCount) * 100);
  const isActive = pendingCount > 0;
  const overallTone = isActive
    ? "attention"
    : failedCount > 0 && completedCount === 0
      ? "critical"
      : failedCount > 0
        ? "warning"
        : "success";
  const overallLabel = isActive
    ? "In Progress"
    : failedCount > 0 && completedCount === 0
      ? "Failed"
      : failedCount > 0
        ? "Partial"
        : "Completed";

  return (
    <IndexTable.Row id={bulkId} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            Bulk run — {run.jobs[0]?.productTitle ?? ""}
            {totalCount > 1 && ` + ${totalCount - 1} more`}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {bulkId.slice(0, 8)}…
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={overallTone}>{overallLabel}</Badge>
          {isActive && <Spinner size="small" />}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <div style={{ width: 120 }}>
            <div
              style={{
                height: 6,
                background: "#e1e3e5",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${percentDone}%`,
                  background:
                    failedCount > 0 && !isActive
                      ? "#c0392b"
                      : isActive
                        ? "#f59e0b"
                        : "#22c55e",
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
          <Text as="span" variant="bodySm" tone="subdued">
            {completedCount}/{totalCount} done
            {failedCount > 0 && ` · ${failedCount} failed`}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {safeDateLabel(run.latestUpdatedAt)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Button size="slim" onClick={() => navigate(`/app/bulk/${bulkId}`)}>
          Review & Apply →
        </Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

// ---------------------------------------------------------------------------
// Main route component
// ---------------------------------------------------------------------------

export default function JobsRoute() {
  const { jobs, hasActiveJobs, hasNextPage, nextCursor, totalPending, shopDomain  } =
    useLoaderData<LoaderData>();

  const revalidator = useRevalidator();
  const cancelAllFetcher = useFetcher<{
    ok: boolean;
    cancelled?: number;
    error?: string;
  }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedJob, setSelectedJob] = useState<JobRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const handleViewDetails = useCallback((job: JobRow) => {
    setSelectedJob(job);
    setModalOpen(true);
  }, []);
  const handleModalClose = useCallback(() => setModalOpen(false), []);

  const isCancellingAll = cancelAllFetcher.state !== "idle";
  const cancelAllResult = cancelAllFetcher.data;
  const isOnFirstPage = !isUuidV4(params.get("cursor"));
  const isRevalidating = revalidator.state !== "idle";

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
      const ms = Math.max(
        750,
        Math.floor(
          POLL_INTERVAL_MS + (Math.random() * 2 - 1) * POLL_INTERVAL_MS * 0.2,
        ),
      );
      timerRef.current = window.setTimeout(tick, ms);
    };
    const tick = () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.hidden) {
        scheduleNext();
        return;
      }
      if (revalidator.state === "idle") revalidator.revalidate();
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

  const handleCancelAll = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "cancel_all");
    cancelAllFetcher.submit(fd, { method: "post" });
  }, [cancelAllFetcher]);

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

  const individualJobs = jobs.filter((j: JobRow) => !j.bulkId);
  const bulkJobs = jobs.filter((j: JobRow) => !!j.bulkId);
  const bulkRuns = buildBulkRuns(bulkJobs);

  const tabs = [
    {
      id: "all",
      content: `All (${jobs.length})`,
      accessibilityLabel: "All",
      panelID: "all-panel",
    },
    {
      id: "individual",
      content: `Individual (${individualJobs.length})`,
      accessibilityLabel: "Individual jobs",
      panelID: "individual-panel",
    },
    {
      id: "bulk",
      content: `Bulk Runs (${bulkRuns.length})`,
      accessibilityLabel: "Bulk runs",
      panelID: "bulk-panel",
    },
  ];

  function renderJobTable(jobList: JobRow[]) {
    if (jobList.length === 0) {
      return (
        <EmptyState
          heading="No jobs here"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>
            Generate descriptions from the{" "}
            <Link to="/app/products">Products</Link> page.
          </p>
        </EmptyState>
      );
    }
    return (
      <>
        <Box padding="300" borderBlockEndWidth="025" borderColor="border">
          <Text as="p" variant="bodySm" tone="subdued">
            Jobs are shop-scoped and actions are idempotent.
          </Text>
        </Box>
        <IndexTable
          resourceName={{ singular: "job", plural: "jobs" }}
          itemCount={jobList.length}
          headings={[
            { title: "Product" },
            { title: "Status" },
            { title: "Details" },
            { title: "Updated" },
            { title: "Actions" },
          ]}
          selectable={false}
        >
          {jobList.map((job, idx) => (
            <JobTableRow
              key={job.id}
              job={job}
              index={idx}
              onViewDetails={handleViewDetails}
            />
          ))}
        </IndexTable>
      </>
    );
  }

  function renderBulkRunsTable() {
    if (bulkRuns.length === 0) {
      return (
        <EmptyState
          heading="No bulk runs yet"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>
            Select multiple products on the{" "}
            <Link to="/app/products">Products</Link> page and click "Generate AI
            Descriptions".
          </p>
        </EmptyState>
      );
    }
    return (
      <>
        <Box padding="300" borderBlockEndWidth="025" borderColor="border">
          <Text as="p" variant="bodySm" tone="subdued">
            Each bulk run groups all products from a single batch generation.
            Click "Review & Apply" to manage results.
          </Text>
        </Box>
        <IndexTable
          resourceName={{ singular: "bulk run", plural: "bulk runs" }}
          itemCount={bulkRuns.length}
          headings={[
            { title: "Run" },
            { title: "Status" },
            { title: "Progress" },
            { title: "Updated" },
            { title: "Actions" },
          ]}
          selectable={false}
        >
          {bulkRuns.map((run, idx) => (
            <BulkRunRow key={run.bulkId} run={run} index={idx} />
          ))}
        </IndexTable>
      </>
    );
  }

  return (
    <Page title="History" fullWidth>
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                History Details
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
                >
                  {`⛔ Cancel All Pending (${totalPending})`}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
        </Card>

        {cancelAllResult?.ok &&
          typeof cancelAllResult.cancelled === "number" && (
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
          <Tabs
            tabs={tabs}
            selected={selectedTab}
            onSelect={setSelectedTab}
            fitted
          />
          <Divider />
          {selectedTab === 0 && renderJobTable(jobs)}
          {selectedTab === 1 && renderJobTable(individualJobs)}
          {selectedTab === 2 && renderBulkRunsTable()}
        </Card>

        {selectedTab !== 2 && (hasNextPage || !isOnFirstPage) && (
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

      <JobDetailModal
        job={selectedJob}
        open={modalOpen}
        onClose={handleModalClose}
        shopDomain={shopDomain}
      />
    </Page>
  );
}
