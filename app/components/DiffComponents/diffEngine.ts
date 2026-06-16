// FILE: app/components/diffViewer/diffEngine.ts
import { LIMITS } from "./limits";

export type DiffType = "equal" | "insert" | "delete";

export type DiffOp = {
  text: string;
  type: DiffType;
};

const MATRIX_CAP_MESSAGE =
  "\n\n--- [Diff too large (matrix cap), showing raw replacement] ---\n\n";
const TOKEN_CAP_MESSAGE =
  "\n\n--- [Diff too large, showing raw replacement] ---\n\n";

function normalizeInput(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
}

function tokenizeRaw(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [];
}

/**
 * Tokenize into words + whitespace segments so we can preserve spacing in render.
 * Uses regex, but pattern is linear and bounded by upstream clamps.
 */
export function tokenize(value: unknown): string[] {
  return tokenizeRaw(normalizeInput(value));
}

/**
 * Build LCS table using a flat Int32Array.
 */
function buildLCSTable(a: string[], b: string[]) {
  const m = a.length;
  const n = b.length;

  const dp = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;

  const idx = (row: number, col: number) => row * stride + col;

  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      dp[idx(i, j)] =
        ai === b[j - 1]
          ? dp[idx(i - 1, j - 1)] + 1
          : Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
    }
  }

  return { dp, stride };
}

function rawReplacement(before: string, after: string, message: string): DiffOp[] {
  return [
    { text: before, type: "delete" },
    { text: message, type: "equal" },
    { text: after, type: "insert" },
  ];
}

function pushReverseRun(runs: DiffOp[], type: DiffType, text: string) {
  const last = runs[runs.length - 1];

  if (last?.type === type) {
    last.text = text + last.text;
    return;
  }

  runs.push({ text, type });
}

/**
 * Word-level diff using LCS with hard caps.
 */
export function buildDiff(beforeValue: unknown, afterValue: unknown): DiffOp[] {
  const before = normalizeInput(beforeValue);
  const after = normalizeInput(afterValue);

  if (!before && !after) return [];
  if (!before) return [{ text: after, type: "insert" }];
  if (!after) return [{ text: before, type: "delete" }];

  const aRaw = tokenizeRaw(before);
  const bRaw = tokenizeRaw(after);

  const tokenCap = LIMITS.MAX_TOKENS_FOR_DIFF;
  if (aRaw.length + bRaw.length > tokenCap * 2) {
    return rawReplacement(before, after, TOKEN_CAP_MESSAGE);
  }

  const m = aRaw.length;
  const n = bRaw.length;

  // 6.5M cells ~= 26MB for Int32Array, before JS engine overhead.
  const MAX_CELLS = 6_500_000;
  if ((m + 1) * (n + 1) > MAX_CELLS) {
    return rawReplacement(before, after, MATRIX_CAP_MESSAGE);
  }

  const { dp, stride } = buildLCSTable(aRaw, bRaw);
  const runs: DiffOp[] = [];
  const idx = (row: number, col: number) => row * stride + col;

  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aRaw[i - 1] === bRaw[j - 1]) {
      pushReverseRun(runs, "equal", aRaw[i - 1]);
      i--;
      j--;
      continue;
    }

    if (j > 0 && (i === 0 || dp[idx(i, j - 1)] >= dp[idx(i - 1, j)])) {
      pushReverseRun(runs, "insert", bRaw[j - 1]);
      j--;
      continue;
    }

    if (i > 0) {
      pushReverseRun(runs, "delete", aRaw[i - 1]);
      i--;
    }
  }

  runs.reverse();
  return runs;
}
