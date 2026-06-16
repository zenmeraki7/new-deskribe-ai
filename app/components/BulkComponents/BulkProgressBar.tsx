// FILE: app/components/BulkProgressBar.tsx
//
// Shown on the Jobs page (/app/jobs) after a bulk generation is kicked off.
// Polls GET /app/api/bulk/:bulkId every ~3s and renders an inline progress bar.
// Disappears (calls onDone) once all jobs reach a terminal state.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  InlineStack,
  ProgressBar,
  Spinner,
  Text,
} from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import type { BulkStatusPayload } from "../../routes/app.api.bulk.$bulkId";

const POLL_MS = 3000;
const JITTER = 0.2;

function scheduleMs() {
  const delta = POLL_MS * JITTER;
  return Math.max(750, Math.floor(POLL_MS + (Math.random() * 2 - 1) * delta));
}

type BulkStatusError = {
  error?: string;
};

type BulkStatusFetcherData = BulkStatusPayload | BulkStatusError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBulkStatusPayload(value: unknown): value is BulkStatusPayload {
  if (!isRecord(value)) return false;

  return (
    typeof value.bulkId === "string" &&
    typeof value.total === "number" &&
    typeof value.pending === "number" &&
    typeof value.processing === "number" &&
    typeof value.completed === "number" &&
    typeof value.failed === "number" &&
    typeof value.cancelled === "number" &&
    typeof value.percentDone === "number" &&
    typeof value.isDone === "boolean"
  );
}

function isBulkStatusError(value: unknown): value is BulkStatusError {
  return isRecord(value) && "error" in value;
}

interface BulkProgressBarProps {
  bulkId: string;
  productCount: number;
  /** Called when the bulk run reaches 100% (all terminal); pass a stable useCallback from callers. */
  onDone?: () => void;
  /** Called when user dismisses the banner manually. */
  onDismiss?: () => void;
}

export function BulkProgressBar({
  bulkId,
  productCount,
  onDone,
  onDismiss,
}: BulkProgressBarProps) {
  const fetcher = useFetcher<BulkStatusFetcherData>();
  const timerRef = useRef<number | null>(null);
  const loadRef = useRef(fetcher.load);
  const [isDone, setIsDone] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const payload = useMemo(
    () => (isBulkStatusPayload(fetcher.data) ? fetcher.data : null),
    [fetcher.data],
  );

  const statusError = useMemo(
    () => (isBulkStatusError(fetcher.data) ? fetcher.data.error : undefined),
    [fetcher.data],
  );

  useEffect(() => {
    loadRef.current = fetcher.load;
  }, [fetcher.load]);

  useEffect(() => {
    clearTimer();
    if (isDone) return;

    let stopped = false;

    const tick = () => {
      if (stopped || isDone) return;
      if (typeof document !== "undefined" && document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }

      loadRef.current(`/app/api/bulk/${bulkId}`);
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };

    tick();

    return () => {
      stopped = true;
      clearTimer();
    };
  }, [bulkId, isDone, clearTimer]);

  useEffect(() => {
    if (!fetcher.data) return;

    if (statusError) {
      setIsDone(true);
      clearTimer();
      return;
    }

    if (!payload) return;

    if (payload.isDone && !isDone) {
      setIsDone(true);
      clearTimer();
      onDone?.();
    }
  }, [fetcher.data, payload, statusError, isDone, onDone, clearTimer]);

  const percent = payload?.percentDone ?? 0;
  const completed = payload?.completed ?? 0;
  const failed = payload?.failed ?? 0;
  const total = payload?.total ?? productCount;
  const inFlight = (payload?.pending ?? 0) + (payload?.processing ?? 0);
  const cancelled = payload?.cancelled ?? 0;

  const statusTone = statusError
    ? "warning"
    : isDone
      ? failed > 0
        ? "warning"
        : "success"
      : "info";

  const title = statusError
    ? statusError
    : isDone
      ? failed > 0
        ? `Bulk run finished - ${completed} succeeded, ${failed} failed`
        : `Bulk run complete - ${completed} description${completed !== 1 ? "s" : ""} generated`
      : `Generating descriptions for ${total} product${total !== 1 ? "s" : ""}...`;

  return (
    <Banner
      tone={statusTone}
      title={title}
      onDismiss={isDone || onDismiss ? onDismiss : undefined}
    >
      <BlockStack gap="300">
        <ProgressBar
          progress={percent}
          size="small"
          tone={failed > 0 && isDone ? "critical" : "highlight"}
        />

        <InlineStack gap="300" blockAlign="center" wrap>
          {!isDone && <Spinner size="small" />}

          <InlineStack gap="200" wrap>
            {completed > 0 && (
              <Badge tone="success">{`${completed} done`}</Badge>
            )}
            {inFlight > 0 && (
              <Badge tone="attention">{`${inFlight} in progress`}</Badge>
            )}
            {failed > 0 && <Badge tone="critical">{`${failed} failed`}</Badge>}
            {cancelled > 0 && (
              <Badge tone="warning">{`${cancelled} cancelled`}</Badge>
            )}
          </InlineStack>

          {payload && (
            <Text as="span" variant="bodySm" tone="subdued">
              {percent}% complete
            </Text>
          )}
        </InlineStack>

        <InlineStack gap="200">
          <Button size="slim" url={`/app/bulk/${bulkId}`} variant="plain">
            Review drafts
          </Button>
          <Button size="slim" url="/app/jobs" variant="plain">
            View history
          </Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}
