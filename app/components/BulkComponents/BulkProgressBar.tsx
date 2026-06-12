// FILE: app/components/BulkProgressBar.tsx
//
// Shown on the Jobs page (/app/jobs) after a bulk generation is kicked off.
// Polls GET /app/api/bulk/:bulkId every ~3 s and renders an inline progress bar.
// Disappears (calls onDone) once all jobs reach a terminal state.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Spinner,
  ProgressBar,
  Badge,
} from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import type { BulkStatusPayload } from "../../routes/app.api.bulk.$bulkId";

const POLL_MS = 3000;
const JITTER = 0.2;

function scheduleMs() {
  const delta = POLL_MS * JITTER;
  return Math.max(750, Math.floor(POLL_MS + (Math.random() * 2 - 1) * delta));
}

interface BulkProgressBarProps {
  bulkId: string;
  productCount: number;
  /** Called when the bulk run reaches 100 % (all terminal) */
  onDone?: () => void;
  /** Called when user dismisses the banner manually */
  onDismiss?: () => void;
}

export function BulkProgressBar({
  bulkId,
  productCount,
  onDone,
  onDismiss,
}: BulkProgressBarProps) {
  const fetcher = useFetcher<BulkStatusPayload>();
  const timerRef = useRef<number | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [data, setData] = useState<BulkStatusPayload | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Poll loop
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
      fetcher.load(`/app/api/bulk/${bulkId}`);
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };

    tick();

    return () => {
      stopped = true;
      clearTimer();
    };
  }, [bulkId, isDone, clearTimer]);

  // Process fetcher data
  useEffect(() => {
    if (!fetcher.data || "error" in fetcher.data) return;
    const payload = fetcher.data as BulkStatusPayload;
    setData(payload);

    if (payload.isDone && !isDone) {
      setIsDone(true);
      clearTimer();
      onDone?.();
    }
  }, [fetcher.data, isDone, onDone, clearTimer]);

  const percent = data?.percentDone ?? 0;
  const completed = data?.completed ?? 0;
  const failed = data?.failed ?? 0;
  const total = data?.total ?? productCount;
  const inFlight = (data?.pending ?? 0) + (data?.processing ?? 0);

  const statusTone = isDone
    ? failed > 0
      ? "warning"
      : "success"
    : "info";

  const title = isDone
    ? failed > 0
      ? `Bulk run finished — ${completed} succeeded, ${failed} failed`
      : `Bulk run complete — ${completed} description${completed !== 1 ? "s" : ""} generated`
    : `Generating descriptions for ${total} product${total !== 1 ? "s" : ""}…`;

  return (
    <Banner
      tone={statusTone}
      title={title}
      onDismiss={isDone || onDismiss ? onDismiss : undefined}
    >
      <BlockStack gap="300">
        {/* Progress bar */}
        <ProgressBar progress={percent} size="small" tone={failed > 0 && isDone ? "critical" : "highlight"} />

        {/* Stats row */}
        <InlineStack gap="300" blockAlign="center" wrap>
          {!isDone && <Spinner size="small" />}

          <InlineStack gap="200" wrap>
            {completed > 0 && (
              <Badge tone="success">{`${completed} done`}</Badge>
            )}
            {inFlight > 0 && (
              <Badge tone="attention">{`${inFlight} in progress`}</Badge>
            )}
            {failed > 0 && (
              <Badge tone="critical">{`${failed} failed`}</Badge>
            )}
            {data?.cancelled != null && data.cancelled > 0 && (
              <Badge tone="warning">{`${data.cancelled} cancelled`}</Badge>
            )}
          </InlineStack>

          <Text as="span" variant="bodySm" tone="subdued">
            {percent}% complete
          </Text>
        </InlineStack>

        {isDone && (
          <InlineStack gap="200">
            <Button
              size="slim"
              url="/app/jobs"
              variant="plain"
            >
              View in History →
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Banner>
  );
}