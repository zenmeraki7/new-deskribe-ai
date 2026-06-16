import { useEffect, useState } from "react";
import type { DiffOp } from "./diffEngine";

export function useDiff(before: unknown, after: unknown) {
  const [result, setResult] = useState<DiffOp[] | null>(null);

  useEffect(() => {
    setResult(null);

    const worker = new Worker(new URL("./diffWorker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = ({ data }: MessageEvent<DiffOp[]>) => {
      setResult(data);
    };

    worker.postMessage({ before, after });

    return () => {
      worker.terminate();
    };
  }, [before, after]);

  return result;
}
