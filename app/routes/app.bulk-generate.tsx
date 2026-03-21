// FILE: app/routes/app.bulk-generate.tsx
//
// Action-only route (no UI).
// POST  /app/bulk-generate
//   FormData fields:
//     intent      = "bulk_generate"
//     productIds  = JSON array of GID strings
//     vibe        = string
//     format      = string
//     keywords    = string (comma-separated)
//     includeSocials = "true" | "false"
//
// Returns JSON: { ok, jobIds, skipped, error? }

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueGenerationJobs } from "../lib/enqueue.server";

const MAX_BULK = 50; // guard against runaway submissions

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent !== "bulk_generate") {
    return json({ ok: false, error: "Unknown intent" }, { status: 400 });
  }

  // --- parse & validate productIds ---
  let productIds: string[];
  try {
    const raw = fd.get("productIds");
    if (typeof raw !== "string") throw new Error("missing");
    productIds = JSON.parse(raw);
    if (!Array.isArray(productIds) || productIds.length === 0)
      throw new Error("empty");
    if (productIds.length > MAX_BULK)
      throw new Error(`max ${MAX_BULK} products per bulk request`);
    if (!productIds.every((id) => typeof id === "string" && id.startsWith("gid://")))
      throw new Error("invalid product id format");
  } catch (e: any) {
    return json({ ok: false, error: `Invalid productIds: ${e.message}` }, { status: 400 });
  }

  // --- other fields ---
  const vibe = String(fd.get("vibe") ?? "casual").slice(0, 40);
  const format = String(fd.get("format") ?? "paragraph").slice(0, 40);
  const keywords = String(fd.get("keywords") ?? "").slice(0, 2000);
  const includeSocials = fd.get("includeSocials") === "true";

  try {
    const { jobIds, skipped, bulkId } = await enqueueGenerationJobs({
      shopDomain,
      productIds,
      vibe,
      format,
      keywords,
      includeSocials,
      adminGraphql: (query, opts) => admin.graphql(query, opts),
    });

    return json({ ok: true, jobIds, skipped, bulkId });
  } catch (err: any) {
    console.error("[bulk-generate] enqueue error:", err);
    return json(
      { ok: false, error: err?.message ?? "Failed to enqueue jobs" },
      { status: 500 },
    );
  }
}