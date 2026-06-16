import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { z } from "zod";

import { bulkGenerateAction } from "../lib/bulkGenerate.server";
import { requireAdminSession } from "../lib/auth.server";
import { MAX_BULK_PRODUCT_COUNT } from "../lib/bulkLimits";
import { resolvePlan, type Plan } from "../lib/rateLimiter.server";
import type { AdminGraphql } from "../lib/shopifyGraphql.server";

const ProductGidSchema = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);

const ProductIdsSchema = z.union([
  z.array(ProductGidSchema).min(1).max(MAX_BULK_PRODUCT_COUNT),
  z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid productIds JSON",
        });
        return z.NEVER;
      }
    })
    .pipe(z.array(ProductGidSchema).min(1).max(MAX_BULK_PRODUCT_COUNT)),
]);

const KeywordsSchema = z.union([
  z.string().max(2000),
  z
    .array(z.string().max(64))
    .max(20)
    .transform((keywords) => keywords.join(", ")),
]);

const BulkGenerateSchema = z.object({
  productIds: ProductIdsSchema,
  vibe: z.enum(["casual", "luxury", "technical", "playful", "minimalist"]),
  format: z.enum(["paragraph", "bullets", "hybrid"]),
  keywords: KeywordsSchema.default(""),
  idempotencyKey: z.string().uuid(),
});

export async function action({ request }: ActionFunctionArgs) {
  const { admin, billing, shopDomain } = await requireAdminSession(request);

  const contentType = request.headers.get("content-type") ?? "";
  const input = contentType.includes("application/json")
    ? await request.json()
    : Object.fromEntries(await request.formData());
  const parsed = BulkGenerateSchema.safeParse(input);

  if (!parsed.success) {
    return json(
      { ok: false, error: "Invalid input", code: "INVALID_INPUT" },
      { status: 422 },
    );
  }

  const adminGraphql: AdminGraphql = (query, opts) =>
    admin.graphql(query, opts);
  let cachedPlan: Plan | null = null;
  const getPlan = async () => {
    if (cachedPlan) return cachedPlan;

    const { appSubscriptions } = await billing.check();
    cachedPlan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

    return cachedPlan;
  };

  const plan = await getPlan();

  return bulkGenerateAction({
    data: parsed.data,
    shopDomain,
    adminGraphql,
    plan,
  });
}
