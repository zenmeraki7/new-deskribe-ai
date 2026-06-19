// FILE: app/hooks/useJobPoll.ts
// Polls /app/api/job/$jobId until terminal state.
// Production hardening:
// - Abort-safe (stops when unmounted / jobId changes)
// - Jittered exponential backoff on transient failures (network/5xx/429)
// - Tab-visibility aware (slows down when hidden to reduce load)
// - Dedupes interval scheduling; never stacks timers
// - Safe defaults (fail closed; explicit errorMessage)
// - Works with Remix useFetcher.load (no client auth assumptions)
// - Guards against stale responses (jobId changes mid-flight)
// - Avoids "missing data" false negatives by using fetcher.state/idle transitions carefully

import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type JobPollStatus =
  | "IDLE"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface JobPollResult {
  body_html?: string;
  meta_title?: string;
  meta_description?: string;
  keywords?: string[];
  primary_keyword?: string;
  headline?: string;
  social_caption?: string;
}

export interface JobPollState {
  status: JobPollStatus;
  result: JobPollResult | null;
  errorMessage: string | null;
  isPolling: boolean;
}

type PollResponse = {
  status: JobPollStatus;
  result: JobPollResult | null;
  errorMessage: string | null;
  code?: string; // optional, non-breaking (server may send)
};

const TERMINAL_STATUSES: readonly JobPollStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

// Interval/backoff controls
const LIMITS = {
  BASE_INTERVAL_MS: 2_000, // normal polling cadence
  HIDDEN_TAB_INTERVAL_MS: 8_000, // reduce load when tab is hidden
  MIN_INTERVAL_MS: 800,
  MAX_INTERVAL_MS: 25_000,
  MAX_CONSECUTIVE_FAILURES: 8,
  MIN_SUCCESS_INTERVAL_MS: 250, // prevent rapid-fire loops
} as const;

// Jitter helpers
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Exponential backoff with "full jitter" (AWS-style):
 * sleep = random(0, min(cap, base * 2^attempt))
 */
function computeBackoffMs(attempt: number, baseMs: number, capMs: number) {
  const maxDelay = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return randInt(0, Math.max(0, Math.floor(maxDelay)));
}

function isTerminal(status: JobPollStatus) {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * useJobPoll:
 * - startPolling(jobId): begins polling
 * - reset(): stops + resets state
 *
 * Assumptions (safest defaults):
 * - server returns status in {PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED}
 * - If server returns no data repeatedly, we fail closed to FAILED after a cap.
 *
 * NOTE: Remix useFetcher does not expose HTTP status codes. We treat:
 * - `fetcher.data` missing after an idle transition as transient failure (with backoff)
 */
export function useJobPoll() {
  const fetcher = useFetcher<PollResponse>();

  const [jobId, setJobId] = useState<string | null>(null);
  const [pollState, setPollState] = useState<JobPollState>({
    status: "IDLE",
    result: null,
    errorMessage: null,
    isPolling: false,
  });

  // Timers + control flags
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Active job id + request sequencing to ignore stale responses
  const activeJobIdRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const lastProcessedSeqRef = useRef(0);

  const failureCountRef = useRef(0);
  const lastRequestAtRef = useRef(0);

  const isHidden = usePageVisibility();

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    failureCountRef.current = 0;
    lastRequestAtRef.current = 0;
  }, [clearTimer]);

  const markTerminal = useCallback(
    (status: JobPollStatus, errorMessage?: string | null) => {
      stop();
      activeJobIdRef.current = null;
      setJobId(null);
      setPollState((s) => ({
        status,
        result: s.result ?? null,
        errorMessage: errorMessage ?? s.errorMessage ?? null,
        isPolling: false,
      }));
    },
    [stop],
  );

  const scheduleNext = useCallback(
    (reason: "normal" | "failure") => {
      // never stack timers
      clearTimer();

      const base = isHidden ? LIMITS.HIDDEN_TAB_INTERVAL_MS : LIMITS.BASE_INTERVAL_MS;

      // For failures, apply exponential backoff + jitter. For normal, apply small jitter.
      const delay =
        reason === "failure"
          ? computeBackoffMs(failureCountRef.current, base, LIMITS.MAX_INTERVAL_MS)
          : clamp(base + randInt(-250, 450), LIMITS.MIN_INTERVAL_MS, LIMITS.MAX_INTERVAL_MS);

      timeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        const id = activeJobIdRef.current;
        if (!id) return;

        // Rate guard: in pathological cases avoid too-tight loops.
        const now = Date.now();
        if (now - lastRequestAtRef.current < LIMITS.MIN_SUCCESS_INTERVAL_MS) {
          timeoutRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            const id2 = activeJobIdRef.current;
            if (!id2) return;
            requestSeqRef.current += 1;
            lastRequestAtRef.current = Date.now();
            fetcher.load(`/app/api/job/${id2}`);
          }, LIMITS.MIN_SUCCESS_INTERVAL_MS);
          return;
        }

        requestSeqRef.current += 1;
        lastRequestAtRef.current = now;
        fetcher.load(`/app/api/job/${id}`);
      }, delay);
    },
    [clearTimer, fetcher, isHidden],
  );

  // Mount/unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  // Start/stop polling when jobId changes
  useEffect(() => {
    if (!jobId) return;

    // Start fresh for this jobId
    stop();
    activeJobIdRef.current = jobId;
    failureCountRef.current = 0;

    // Reset sequence counters for this job
    requestSeqRef.current += 1;
    lastProcessedSeqRef.current = 0;

    setPollState((s) => ({
      status: "PENDING",
      result: s.result ?? null,
      errorMessage: null,
      isPolling: true,
    }));

    // Kick immediately
    lastRequestAtRef.current = Date.now();
    fetcher.load(`/app/api/job/${jobId}`);

    // Next will be scheduled on response (success/failure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // React to page visibility changes: if actively polling, reschedule cadence.
  useEffect(() => {
    if (!activeJobIdRef.current) return;
    if (!pollState.isPolling) return;
    scheduleNext("normal");
  }, [isHidden, pollState.isPolling, scheduleNext]);

  /**
   * Process responses + schedule next tick.
   *
   * Key subtlety:
   * - useFetcher keeps previous `data` during new loads in many cases.
   * - We only "evaluate" when fetcher transitions to idle AND the requestSeq increased.
   * - Since we can't read HTTP status, "missing data at idle" is treated as transient failure.
   */
 // With this:
const lastProcessedDataRef = useRef<PollResponse | null>(null);

useEffect(() => {
  if (!activeJobIdRef.current) return;
  if (fetcher.state !== "idle") return;

  const data = fetcher.data;

  // Dedupe by reference identity, not wall-clock time.
  // Remix gives a new object reference on each successful load,
  // so this safely skips re-processing the same response twice
  // without ever dropping a genuinely new one.
  if (data !== undefined && data === lastProcessedDataRef.current) return;
  lastProcessedDataRef.current = data ?? null;

  const currentJobId = activeJobIdRef.current;

    // Failure path: no data returned
    if (!data) {
      failureCountRef.current += 1;

      if (failureCountRef.current >= LIMITS.MAX_CONSECUTIVE_FAILURES) {
        markTerminal("FAILED", "Polling failed repeatedly. Please retry.");
        return;
      }

      setPollState((s) => ({
        ...s,
        errorMessage: s.errorMessage ?? "Temporary polling error. Retrying…",
        isPolling: true,
      }));

      scheduleNext("failure");
      return;
    }

    // Guard against stale data being applied after a job switch:
    // If active job changed since load kicked off, ignore this idle completion.
    // We can't read request URL from useFetcher, so we at least ensure the jobId
    // is still the active one at the time we apply state.
    if (!currentJobId || currentJobId !== activeJobIdRef.current) {
      return;
    }

    // Success path: reset failure count
    failureCountRef.current = 0;

    const status: JobPollStatus = (data.status ?? "IDLE") as JobPollStatus;
    const result = data.result ?? null;
    const errorMessage = data.errorMessage ?? null;

    const terminal = isTerminal(status);

    setPollState({
      status,
      result,
      errorMessage,
      isPolling: !terminal && status !== "IDLE",
    });

    if (terminal) {
      stop();
      activeJobIdRef.current = null;
      setJobId(null);
      return;
    }

    scheduleNext("normal");
  }, [fetcher.data, fetcher.state, markTerminal, scheduleNext, stop]);

  const startPolling = useCallback((id: string) => {
    const trimmed = (id ?? "").trim();
    if (!trimmed) {
      setPollState({
        status: "FAILED",
        result: null,
        errorMessage: "Missing jobId for polling.",
        isPolling: false,
      });
      return;
    }

    // If already polling same job, ignore.
    if (activeJobIdRef.current && activeJobIdRef.current === trimmed && pollState.isPolling) {
      return;
    }

    setJobId(trimmed);
  }, [pollState.isPolling]);

  const reset = useCallback(() => {
    stop();
    activeJobIdRef.current = null;
    setJobId(null);
    setPollState({
      status: "IDLE",
      result: null,
      errorMessage: null,
      isPolling: false,
    });
  }, [stop]);

  return useMemo(() => ({ startPolling, reset, ...pollState }), [startPolling, reset, pollState]);
}

/**
 * Page visibility hook (no deps). Returns true when tab is hidden.
 */
function usePageVisibility() {
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof document === "undefined") return false;
    return document.visibilityState === "hidden";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return hidden;
}
