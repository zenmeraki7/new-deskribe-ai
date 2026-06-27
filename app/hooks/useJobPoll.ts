// FILE: app/hooks/useJobPoll.ts
// Polls /app/api/job/$jobId until terminal state.
// Production hardening:
// - Abort-safe (stops when unmounted / jobId changes)
// - Jittered exponential backoff on transient failures (network/5xx/429)
// - Tab-visibility aware (slows down when hidden to reduce load)
// - Dedupes repeated fetcher responses by status signature, not object identity
// - Safe defaults (fail closed; explicit errorMessage)
// - Works with Remix useFetcher.load (no client auth assumptions)
// - Guards against stale responses when jobId changes mid-flight

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
  jobId: string | null;
  lastCompletedJobId: string | null;
}

type PollResponse = {
  status: JobPollStatus;
  result: JobPollResult | null;
  errorMessage: string | null;
  code?: string;
};

const TERMINAL_STATUSES: readonly JobPollStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

const LIMITS = {
  BASE_INTERVAL_MS: 2_000,
  HIDDEN_TAB_INTERVAL_MS: 8_000,
  MIN_INTERVAL_MS: 800,
  MAX_INTERVAL_MS: 25_000,
  MAX_CONSECUTIVE_FAILURES: 8,
  MIN_SUCCESS_INTERVAL_MS: 250,
} as const;

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeBackoffMs(attempt: number, baseMs: number, capMs: number) {
  const maxDelay = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return randInt(0, Math.max(0, Math.floor(maxDelay)));
}

function isTerminal(status: JobPollStatus) {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function useJobPoll() {
  const fetcher = useFetcher<PollResponse>();

  const [jobId, setJobId] = useState<string | null>(null);
  const [lastCompletedJobId, setLastCompletedJobId] = useState<string | null>(null);
  const [pollState, setPollState] = useState<JobPollState>({
    status: "IDLE",
    result: null,
    errorMessage: null,
    isPolling: false,
    jobId: null,
    lastCompletedJobId: null,
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const activeJobIdRef = useRef<string | null>(null);
  const failureCountRef = useRef(0);
  const lastRequestAtRef = useRef(0);
  const lastProcessedSignatureRef = useRef<string | null>(null);

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
      setPollState((s) => ({
        status,
        result: s.result ?? null,
        errorMessage: errorMessage ?? s.errorMessage ?? null,
        isPolling: false,
        jobId: s.jobId,
        lastCompletedJobId: s.lastCompletedJobId,
      }));
    },
    [stop],
  );

  const scheduleNext = useCallback(
    (reason: "normal" | "failure") => {
      clearTimer();

      const base = isHidden ? LIMITS.HIDDEN_TAB_INTERVAL_MS : LIMITS.BASE_INTERVAL_MS;
      const delay =
        reason === "failure"
          ? computeBackoffMs(failureCountRef.current, base, LIMITS.MAX_INTERVAL_MS)
          : clamp(base + randInt(-250, 450), LIMITS.MIN_INTERVAL_MS, LIMITS.MAX_INTERVAL_MS);

      timeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        const id = activeJobIdRef.current;
        if (!id) return;

        const now = Date.now();
        if (now - lastRequestAtRef.current < LIMITS.MIN_SUCCESS_INTERVAL_MS) {
          timeoutRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            const delayedId = activeJobIdRef.current;
            if (!delayedId) return;
            lastRequestAtRef.current = Date.now();
            fetcher.load(`/app/api/job/${delayedId}`);
          }, LIMITS.MIN_SUCCESS_INTERVAL_MS);
          return;
        }

        lastRequestAtRef.current = now;
        fetcher.load(`/app/api/job/${id}`);
      }, delay);
    },
    [clearTimer, fetcher, isHidden],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!jobId) return;

    stop();
    activeJobIdRef.current = jobId;
    lastProcessedSignatureRef.current = null;

    setPollState((s) => ({
      status: "PENDING",
      result: s.result ?? null,
      errorMessage: null,
      isPolling: true,
      jobId,
      lastCompletedJobId: s.lastCompletedJobId,
    }));

    lastRequestAtRef.current = Date.now();
    fetcher.load(`/app/api/job/${jobId}`);
  }, [fetcher, jobId, stop]);

  useEffect(() => {
    if (!activeJobIdRef.current) return;
    if (!pollState.isPolling) return;
    scheduleNext("normal");
  }, [isHidden, pollState.isPolling, scheduleNext]);

  useEffect(() => {
    if (!activeJobIdRef.current) return;
    if (fetcher.state !== "idle") return;

    const currentJobId = activeJobIdRef.current;
    const data = fetcher.data;

    if (!data) {
      if (lastProcessedSignatureRef.current === "no-data") return;
      lastProcessedSignatureRef.current = "no-data";

      failureCountRef.current += 1;
      if (failureCountRef.current >= LIMITS.MAX_CONSECUTIVE_FAILURES) {
        markTerminal("FAILED", "Polling failed repeatedly. Please retry.");
        return;
      }

      setPollState((s) => ({
        ...s,
        errorMessage: s.errorMessage ?? "Temporary polling error. Retrying...",
        isPolling: true,
      }));
      scheduleNext("failure");
      return;
    }

    if (!currentJobId || currentJobId !== activeJobIdRef.current) {
      return;
    }

   const status = (data.status ?? "IDLE") as JobPollStatus;

// Only deduplicate terminal states — never skip PENDING/PROCESSING
// because skipping them also skips the scheduleNext() call below,
// which stalls the poll loop entirely.
if (isTerminal(status)) {
  const terminalSig = `${currentJobId}:${status}`;
  if (terminalSig === lastProcessedSignatureRef.current) return;
  lastProcessedSignatureRef.current = terminalSig;
} else {
  // For non-terminal, always process — never deduplicate
  lastProcessedSignatureRef.current = null;
}
    failureCountRef.current = 0;

    // const status = (data.status ?? "IDLE") as JobPollStatus;
    const result = data.result ?? null;
    const errorMessage = data.errorMessage ?? null;
    const terminal = isTerminal(status);
    const nextCompletedJobId = status === "COMPLETED" ? currentJobId : lastCompletedJobId;

    if (status === "COMPLETED") {
      setLastCompletedJobId(currentJobId);
    }

    setPollState({
      status,
      result,
      errorMessage,
      isPolling: !terminal && status !== "IDLE",
      jobId: currentJobId,
      lastCompletedJobId: nextCompletedJobId,
    });

    if (terminal) {
      stop();
      activeJobIdRef.current = null;
      return;
    }

    scheduleNext("normal");
  }, [fetcher.data, fetcher.state, lastCompletedJobId, markTerminal, scheduleNext, stop]);

  const startPolling = useCallback(
    (id: string) => {
      const trimmed = (id ?? "").trim();
      if (!trimmed) {
        setPollState({
          status: "FAILED",
          result: null,
          errorMessage: "Missing jobId for polling.",
          isPolling: false,
          jobId: null,
          lastCompletedJobId,
        });
        return;
      }

      if (activeJobIdRef.current === trimmed && pollState.isPolling) {
        return;
      }

      setJobId(trimmed);
    },
    [lastCompletedJobId, pollState.isPolling],
  );

  const reset = useCallback(() => {
    stop();
    activeJobIdRef.current = null;
    lastProcessedSignatureRef.current = null;
    setJobId(null);
    setLastCompletedJobId(null);
    setPollState({
      status: "IDLE",
      result: null,
      errorMessage: null,
      isPolling: false,
      jobId: null,
      lastCompletedJobId: null,
    });
  }, [stop]);

  return useMemo(
    () => ({ startPolling, reset, stop, ...pollState }),
    [pollState, reset, startPolling, stop],
  );
}

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
