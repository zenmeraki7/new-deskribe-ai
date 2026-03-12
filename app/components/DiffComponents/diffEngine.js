// FILE: app/components/diffViewer/diffEngine.js
import { LIMITS } from "./limits";

/**
 * Diff engine (UI-side)
 *
 * Security + performance contract:
 * - This is for display only, never for persistence.
 * - LCS is O(N*M) memory/time; we must bound work deterministically.
 * - If bounds are exceeded, we fail closed into a "raw replacement" view.
 */

/**
 * Tokenize into words + whitespace segments so we can preserve spacing in render.
 * Uses regex, but pattern is linear and bounded by upstream clamps.
 */
export function tokenize(str) {
  const s = typeof str === "string" ? str : "";
  // Match either a run of non-whitespace or a run of whitespace.
  return s.match(/\S+|\s+/g) ?? [];
}

/**
 * Build LCS table using a flat Int32Array.
 * NOTE: This requires (m+1)*(n+1) ints; we must hard-cap m*n.
 */
function buildLCSTable(a, b) {
  const m = a.length;
  const n = b.length;

  const dp = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;

  const idx = (row, col) => row * stride + col;

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

/**
 * Merge adjacent runs of the same type to reduce render cost.
 * Returns the same shape: Array<{ text, type }>
 */
function coalesce(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return [];
  const out = [];

  for (const op of ops) {
    if (!op || typeof op.text !== "string" || !op.type) continue;
    const last = out[out.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      out.push({ text: op.text, type: op.type });
    }
  }

  return out;
}

/**
 * Word-level diff using LCS with hard caps.
 * Returns: Array<{ text: string, type: "equal"|"insert"|"delete" }>
 */
export function buildDiff(beforeStr, afterStr) {
  const before = typeof beforeStr === "string" ? beforeStr : "";
  const after = typeof afterStr === "string" ? afterStr : "";

  const aRaw = tokenize(before);
  const bRaw = tokenize(after);

  // Hard cap on token count (simple guard).
  const tokenCap = LIMITS.MAX_TOKENS_FOR_DIFF;
  if (aRaw.length + bRaw.length > tokenCap * 2) {
    return coalesce([
      { text: before, type: "delete" },
      { text: "\n\n--- [Diff too large, showing raw replacement] ---\n\n", type: "equal" },
      { text: after, type: "insert" },
    ]);
  }

  // Stronger cap: limit the DP matrix size to prevent memory blowups.
  // With MAX_TOKENS_FOR_DIFF=2500, worst-case matrix is ~6.25M ints (~25MB) plus overhead.
  // We still cap explicitly in case LIMITS is changed.
  const m = aRaw.length;
  const n = bRaw.length;

  const MAX_CELLS = 6_500_000; // safe upper bound for UI environments
  if ((m + 1) * (n + 1) > MAX_CELLS) {
    return coalesce([
      { text: before, type: "delete" },
      { text: "\n\n--- [Diff too large (matrix cap), showing raw replacement] ---\n\n", type: "equal" },
      { text: after, type: "insert" },
    ]);
  }

  const { dp, stride } = buildLCSTable(aRaw, bRaw);
  const result = [];

  const idx = (row, col) => row * stride + col;

  let i = m;
  let j = n;

  // Backtrack to produce edits.
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aRaw[i - 1] === bRaw[j - 1]) {
      result.unshift({ text: aRaw[i - 1], type: "equal" });
      i--;
      j--;
      continue;
    }

    // Prefer inserts when tie, to keep behavior deterministic.
    if (j > 0 && (i === 0 || dp[idx(i, j - 1)] >= dp[idx(i - 1, j)])) {
      result.unshift({ text: bRaw[j - 1], type: "insert" });
      j--;
      continue;
    }

    if (i > 0) {
      result.unshift({ text: aRaw[i - 1], type: "delete" });
      i--;
      continue;
    }

    // Should be unreachable, but defensive.
    break;
  }

  // Reduce output size to improve React render performance.
  return coalesce(result);
}
