// FILE: app/components/BulkComponents/BulkLiveResults.tsx
//
// Renders inside BulkGenerateModal once a description run has been queued.
// Polls Tier 1 for live status, renders a JobCard per product, and fetches
// Tier 2 only when a preview is opened. Apply one/all post to the existing
// /app/bulk/:bulkId action — no new mutation logic.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import { BlockStack, InlineStack, Text, ProgressBar, Banner, Spinner, Button } from "@shopify/polaris";
import { JobCard } from "./JobCard";
import { PreviewModal } from "./PreviewModal";
import type { BulkStatusPayload } from "../../routes/app.api.bulk.$bulkId";
import type { BulkJobDetailPayload } from "../../routes/app.api.bulk.$bulkId.job.$jobId";

const POLL_MS = 3500;
const JITTER = 0.2;

function scheduleMs() {
  const delta = POLL_MS * JITTER;
  return Math.max(1000, Math.floor(POLL_MS + (Math.random() * 2 - 1) * delta));
}

interface BulkLiveResultsProps {
  bulkId: string;
  shopDomain: string;
  onDone?: () => void;
}

export function BulkLiveResults({ bulkId, shopDomain, onDone }: BulkLiveResultsProps) {
  const statusFetcher = useFetcher<BulkStatusPayload>();
  const detailFetcher = useFetcher<BulkJobDetailPayload>();
  const applyOneFetcher = useFetcher<{ ok: boolean; error?: string; jobId?: string }>();
  const applyAllFetcher = useFetcher<{ ok: boolean; error?: string; succeeded?: number; failed?: number; total?: number }>();
  const retryFetcher = useFetcher<{ ok: boolean; error?: string; jobId?: string }>();

  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [actingJobId, setActingJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [appliedJobIds, setAppliedJobIds] = useState<Set<string>>(new Set());

  const doneNotifiedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (statusFetcher.state === "idle") statusFetcher.load(`/app/api/bulk/${bulkId}`);
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };
    tick();
    return () => {
      stopped = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkId]);

  const status = statusFetcher.data;

  useEffect(() => {
    if (status?.isDone && !doneNotifiedRef.current) {
      doneNotifiedRef.current = true;
      onDone?.();
    }
    if (status?.isDone && timerRef.current) window.clearTimeout(timerRef.current);
  }, [status?.isDone, onDone]);

  const handlePreview = useCallback(
    (jobId: string) => {
      setPreviewJobId(jobId);
      setPreviewOpen(true);
      detailFetcher.load(`/app/api/bulk/${bulkId}/job/${jobId}`);
    },
    [bulkId, detailFetcher],
  );

  const handleApplyOne = useCallback(
    (jobId: string) => {
      setActingJobId(jobId);
      const fd = new FormData();
      fd.set("intent", "apply_one");
      fd.set("jobId", jobId);
      applyOneFetcher.submit(fd, { method: "post", action: `/app/bulk/${bulkId}` });
    },
    [bulkId, applyOneFetcher],
  );

  useEffect(() => {
    if (!applyOneFetcher.data) return;
    if (applyOneFetcher.data.ok && applyOneFetcher.data.jobId) {
      setAppliedJobIds((prev) => new Set([...prev, applyOneFetcher.data!.jobId!]));
    }
    setActingJobId(null);
  }, [applyOneFetcher.data]);

  const handleApplyAll = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "apply_all");
    applyAllFetcher.submit(fd, { method: "post", action: `/app/bulk/${bulkId}` });
  }, [bulkId, applyAllFetcher]);

  useEffect(() => {
    if (applyAllFetcher.data?.ok && statusFetcher.state === "idle") {
      statusFetcher.load(`/app/api/bulk/${bulkId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyAllFetcher.data]);

  const handleRetryOne = useCallback(
    (jobId: string) => {
      setRetryingJobId(jobId);
      const fd = new FormData();
      fd.set("intent", "retry_one");
      fd.set("jobId", jobId);
      retryFetcher.submit(fd, { method: "post", action: `/app/bulk/${bulkId}` });
    },
    [bulkId, retryFetcher],
  );

  useEffect(() => {
    if (!retryFetcher.data) return;
    setRetryingJobId(null);
    if (retryFetcher.data.ok && statusFetcher.state === "idle") {
      statusFetcher.load(`/app/api/bulk/${bulkId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryFetcher.data]);

  const unappliedCompleted =
    status?.jobs.filter((j) => j.status === "COMPLETED" && !j.applied && !appliedJobIds.has(j.id)) ?? [];
  const canApplyAll = unappliedCompleted.length > 0 && applyAllFetcher.state === "idle";
  const isApplyingAll = applyAllFetcher.state !== "idle";

  const previewDetail = detailFetcher.data?.job ?? null;
  const isPreviewLoading = previewOpen && (detailFetcher.state !== "idle" || previewDetail?.id !== previewJobId);

  if (!status) {
    return (
      <InlineStack gap="300" blockAlign="center">
        <Spinner size="small" />
        <Text as="p">Loading progress…</Text>
      </InlineStack>
    );
  }

  return (
    <BlockStack gap="400">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {status.isDone ? "Generation complete" : `Generating ${status.total} descriptions…`}
          </Text>
          {!status.isDone && (
            <InlineStack gap="150" blockAlign="center">
              <Spinner size="small" />
              <Text as="span" variant="bodySm" tone="subdued">Live</Text>
            </InlineStack>
          )}
        </InlineStack>
        <ProgressBar progress={status.percentDone} tone={status.failed > 0 ? "critical" : "highlight"} />
        <Text as="p" variant="bodySm" tone="subdued">
          {status.completed} completed · {status.pending + status.processing} in progress · {status.failed} failed
        </Text>
      </BlockStack>

      {applyAllFetcher.data?.ok && (
        <Banner
          tone={applyAllFetcher.data.failed! > 0 ? "warning" : "success"}
          title={
            applyAllFetcher.data.failed! > 0
              ? `Applied ${applyAllFetcher.data.succeeded} of ${applyAllFetcher.data.total} — ${applyAllFetcher.data.failed} failed`
              : `All ${applyAllFetcher.data.succeeded} description${applyAllFetcher.data.succeeded !== 1 ? "s" : ""} applied to Shopify`
          }
        />
      )}
      {applyAllFetcher.data && !applyAllFetcher.data.ok && (
        <Banner tone="critical" title="Apply All failed">{applyAllFetcher.data.error ?? "An unexpected error occurred."}</Banner>
      )}

      {canApplyAll && (
        <InlineStack align="end">
          <Button variant="primary" tone="success" onClick={handleApplyAll} loading={isApplyingAll} disabled={isApplyingAll}>
            {isApplyingAll ? "Applying…" : `Apply All (${unappliedCompleted.length})`}
          </Button>
        </InlineStack>
      )}

      <BlockStack gap="300">
        {status.jobs.map((j) => (
          <JobCard
            key={j.id}
            job={{
              id: j.id,
              productId: j.productId,
              productTitle: j.productTitle,
              status: j.status,
              errorMessage: null,
              appliedAt: appliedJobIds.has(j.id) || j.applied ? new Date().toISOString() : null,
            }}
            onPreview={handlePreview}
            onApplyOne={handleApplyOne}
            onRetryOne={handleRetryOne}
            isApplying={actingJobId === j.id && applyOneFetcher.state !== "idle"}
            isRetrying={retryingJobId === j.id && retryFetcher.state !== "idle"}
            applySucceeded={appliedJobIds.has(j.id)}
            showFullEditorLink
          />
        ))}
      </BlockStack>

      <PreviewModal
        job={previewDetail}
        isLoading={isPreviewLoading}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        onApply={handleApplyOne}
        isApplying={previewJobId !== null && actingJobId === previewJobId && applyOneFetcher.state !== "idle"}
        applySuccess={previewJobId !== null && appliedJobIds.has(previewJobId)}
        applyError={
          previewJobId !== null && applyOneFetcher.data?.ok === false && actingJobId === previewJobId
            ? (applyOneFetcher.data.error ?? null)
            : null
        }
        shopDomain={shopDomain}
        showOpenEditorAction={false}
      />
    </BlockStack>
  );
}