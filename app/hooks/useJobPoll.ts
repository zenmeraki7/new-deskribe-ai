// FILE: app/hooks/useJobPoll.ts
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

  // ── Stable handle to the latest fetcher ────────────────────────────────
  // useFetcher() returns a NEW object on every state transition
  // (idle → loading → idle). Anything that closes over `fetcher` directly
  // in a useCallback/useEffect dependency array gets rebuilt/refired on
  // every single poll tick, which cascades into an abort/refetch loop.
  // Keep a ref instead, and read `.load` off the ref inside timers.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

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

  // ── scheduleNext is now stable across fetch ticks ──────────────────────
  // Only depends on `isHidden` (which legitimately should change behavior)
  // and stable refs/callbacks. It reads the fetcher via fetcherRef so it
  // never needs `fetcher` itself as a dependency.
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

        // Don't stack a new load on top of one already in flight.
        if (fetcherRef.current.state !== "idle") {
          timeoutRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            const delayedId = activeJobIdRef.current;
            if (!delayedId) return;
            lastRequestAtRef.current = Date.now();
            fetcherRef.current.load(`/app/api/job/${delayedId}`);
          }, LIMITS.MIN_SUCCESS_INTERVAL_MS);
          return;
        }

        const now = Date.now();
        if (now - lastRequestAtRef.current < LIMITS.MIN_SUCCESS_INTERVAL_MS) {
          timeoutRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            const delayedId = activeJobIdRef.current;
            if (!delayedId) return;
            lastRequestAtRef.current = Date.now();
            fetcherRef.current.load(`/app/api/job/${delayedId}`);
          }, LIMITS.MIN_SUCCESS_INTERVAL_MS);
          return;
        }

        lastRequestAtRef.current = now;
        fetcherRef.current.load(`/app/api/job/${id}`);
      }, delay);
    },
    [clearTimer, isHidden],
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
    fetcherRef.current.load(`/app/api/job/${jobId}`);
  }, [jobId, stop]);

  useEffect(() => {
    if (!activeJobIdRef.current) return;
    if (!pollState.isPolling) return;
    scheduleNext("normal");
    // Only re-run this when polling actually starts/stops or visibility
    // changes — scheduleNext is stable now so this won't thrash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Dedupe on a signature that reflects the actual payload, not render
    // churn — this stops the effect from re-triggering scheduleNext when
    // nothing about the poll result has actually changed.
    const signature = `${currentJobId}:${status}:${JSON.stringify(data.result)}:${data.errorMessage ?? ""}`;
    if (signature === lastProcessedSignatureRef.current) return;
    lastProcessedSignatureRef.current = signature;

    failureCountRef.current = 0;

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