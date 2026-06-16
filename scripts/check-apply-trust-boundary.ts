import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateEnqueueApplyJob } from "../app/server/validation/serverLimits";

const root = process.cwd();

function readProjectFile(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function fail(message: string): never {
  console.error(`[apply-trust-boundary] ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string) {
  if (!condition) fail(message);
}

function assertIncludes(haystack: string, needle: string, label: string) {
  assert(haystack.includes(needle), `${label} must include: ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string) {
  assert(!haystack.includes(needle), `${label} must not include: ${needle}`);
}

const idsOnlyPayload = {
  jobId: "11111111-1111-4111-8111-111111111111",
  applyId: "22222222-2222-4222-8222-222222222222",
  productIds: ["gid://shopify/Product/1234567890"],
};

const parsed = validateEnqueueApplyJob(idsOnlyPayload);
assert(
  Object.keys(parsed).sort().join(",") === "applyId,jobId,productIds",
  "apply payload must parse to IDs only",
);

const maliciousPayload = {
  ...idsOnlyPayload,
  descriptionHtml: "<p>browser supplied HTML must never be trusted</p>",
  fields: {
    descriptionHtml: "<p>browser supplied fields must never be trusted</p>",
  },
  seoTitle: "browser supplied title",
};

let rejectedMaliciousPayload = false;
try {
  validateEnqueueApplyJob(maliciousPayload);
} catch (error) {
  rejectedMaliciousPayload = true;
  const details = JSON.stringify(error);
  assert(
    details.includes("descriptionHtml") ||
      details.includes("fields") ||
      details.includes("seoTitle") ||
      details.includes("unrecognized_keys"),
    "malicious apply payload should be rejected as unrecognized input",
  );
}

assert(
  rejectedMaliciousPayload,
  "malicious apply payload with generated SEO content must be rejected",
);

const serverLimits = readProjectFile("app/server/validation/serverLimits.ts");
assertIncludes(
  serverLimits,
  "export const enqueueApplyJobSchema",
  "apply schema",
);
assertIncludes(serverLimits, "jobId: uuidSchema", "apply schema");
assertIncludes(serverLimits, "applyId: uuidSchema", "apply schema");
assertIncludes(serverLimits, "productIds: z", "apply schema");
assertIncludes(serverLimits, ".strict()", "apply schema");

const applyRoute = readProjectFile("app/routes/app.api.apply.ts");
assertIncludes(applyRoute, "validateEnqueueApplyJob(raw)", "apply route");
assertIncludes(applyRoute, "enqueueApplyJob({", "apply route");

for (const forbidden of [
  "descriptionHtml",
  "seoTitle",
  "seoDescription",
  "handle",
  "tags",
  "fields",
]) {
  assertNotIncludes(
    applyRoute,
    forbidden,
    "apply route must not read browser-submitted generated content",
  );
}

const applyServer = readProjectFile("app/lib/apply.server.ts");
assertIncludes(applyServer, "validateEnqueueApplyJob({", "apply server");
assertIncludes(applyServer, "shopDomain,", "apply server");
assertIncludes(applyServer, "jobId,", "apply server");
assertIncludes(applyServer, "applyId,", "apply server");
assertIncludes(applyServer, "productIds,", "apply server");
assertIncludes(applyServer, 'status: "READY"', "apply server");

for (const forbidden of [
  "descriptionHtml",
  "seoTitle",
  "seoDescription",
  "handle",
  "tags",
]) {
  assertNotIncludes(
    applyServer,
    forbidden,
    "apply server must not enqueue browser-submitted generated content",
  );
}

const applyProcessor = readProjectFile("app/worker/apply/processor.ts");
const applyProduct = readProjectFile("app/worker/apply/applyProduct.ts");
const applyWorker = readProjectFile("app/worker/apply.worker.ts");

assertIncludes(
  applyWorker,
  'export { startApplyWorker } from "./apply"',
  "apply worker compatibility export",
);

assertIncludes(
  applyProcessor,
  "db.generatedSeoOutput.findMany({",
  "apply worker",
);
assertIncludes(applyProcessor, "shopDomain,", "apply worker DB output query");
assertIncludes(applyProcessor, "jobId,", "apply worker DB output query");
assertIncludes(
  applyProcessor,
  "productId: { in: productIds }",
  "apply worker DB output query",
);
assertIncludes(
  applyProcessor,
  'status: { in: ["READY", "APPLIED"] }',
  "apply worker DB output query",
);
assertIncludes(applyProcessor, "fields: true", "apply worker DB output query");
assertIncludes(
  applyProduct,
  "parseAndResanitizeSeoFields(output.fields)",
  "apply worker output validation",
);
assertIncludes(
  applyProduct,
  "await updateProductSeo(adminGraphql, productId, fields)",
  "apply worker Shopify mutation",
);
assertIncludes(
  applyProduct,
  "const input = buildProductInput(productId, fields)",
  "apply worker Shopify mutation input",
);

console.log("[apply-trust-boundary] passed");
