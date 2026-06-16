import { spawnSync } from "node:child_process";

const forbiddenTerms = [
  "bulkWriteBackSchema",
  "validateBulkWriteBack",
  "BulkWriteBackPayload",
];

const result = spawnSync(
  "rg",
  [
    "--line-number",
    "--fixed-strings",
    ...forbiddenTerms.flatMap((term) => ["--regexp", term]),
    "--glob",
    "!scripts/check-no-legacy-writeback.js",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!build/**",
    "--glob",
    "!dist/**",
    "app",
  ],
  { encoding: "utf8" },
);

if (result.error) {
  console.error("Could not run rg for legacy write-back guard.");
  console.error(result.error.message);
  process.exit(1);
}

if (result.status === 0) {
  console.error(
    "Legacy browser-submitted SEO write-back symbols are forbidden:\n",
  );
  console.error(result.stdout.trim());
  console.error(
    "\nUse the ID-only apply path: jobId/applyId/productIds -> server-stored GeneratedSeoOutput.",
  );
  process.exit(1);
}

if (result.status !== 1) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

console.log("No legacy browser-submitted SEO write-back symbols found.");
