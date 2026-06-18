// FILE: app/routes/app.bulk.$bulkId.tsx
//
// Full-page bulk review UI.
// GET  /app/bulk/:bulkId  — shows all jobs in a bulk run with preview + apply
// POST /app/bulk/:bulkId  — intent: "apply_one" | "apply_all" | "retry_one"

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { db } from "../lib/db.server";
import { requireAdminSession } from "../lib/auth.server";
import { sanitiseHtml } from "../lib/html.server";
import { generationJobDefaults, generationQueue } from "../lib/queue.server";
import BulkReviewPage from "./app.bulk.$bulkId.ui";
import { checkAndIncrementRateLimit, resolvePlan } from "app/lib/rateLimiter.server";
import { CREDIT_COSTS, deductCredits, refundCredits } from "app/lib/creditService.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string) {
  return UUID_RE.test(s);
}

function parseDraftHtml(result: any): string {
  if (!result || typeof result !== "object") return "";
  const raw = result.body_html ?? "";
  if (typeof raw !== "string") return "";
  return sanitiseHtml(raw);
}

function parseMeta(result: any) {
  if (!result || typeof result !== "object") return null;
  return {
    meta_title: typeof result.meta_title === "string" ? result.meta_title : "",
    meta_description: typeof result.meta_description === "string" ? result.meta_description : "",
    keywords: Array.isArray(result.keywords)
      ? result.keywords.filter((k: unknown) => typeof k === "string")
      : [],
    social_caption: typeof result.social_caption === "string" ? result.social_caption : "",
  };
}

// ── Shopify apply helper ───────────────────────────────────────────────────────

async function applyDescriptionToShopify(
  adminGraphql: (q: string, opts?: any) => Promise<Response>,
  productId: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await adminGraphql(
      `#graphql
      mutation UpdateDescription($id: ID!, $descriptionHtml: String!) {
        productUpdate(input: { id: $id, descriptionHtml: $descriptionHtml }) {
          product { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: productId, descriptionHtml: html } },
    );
    const data = await resp.json();
    const userErrors = data?.data?.productUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: userErrors.map((e: any) => e.message).join("; ") };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Unknown error" };
  }
}

// ── Types shared with UI ───────────────────────────────────────────────────────

export interface BulkJobItem {
  id: string;
  productId: string;
  productTitle: string;
  status: string;
  errorMessage: string | null;
  bodyHtml: string;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  socialCaption: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vibe: string;
  format: string;
}

export interface BulkLoaderData {
  bulkId: string;
  jobs: BulkJobItem[];
  totalCount: number;
  completedCount: number;
  pendingCount: number;
  failedCount: number;
  appliedCount: number;
  shopDomain: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { shopDomain } = await requireAdminSession(request);

  const { bulkId } = params;
  if (!bulkId || !isUuid(bulkId)) {
    throw new Response("Invalid bulk ID", { status: 400 });
  }

  const rawJobs = await db.generationJob.findMany({
    where: { bulkId, shopDomain },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      productId: true,
      productTitle: true,
      status: true,
      errorMessage: true,
      result: true,
      createdAt: true,
      updatedAt: true,
      vibe: true,
      format: true,
      generatedDescription: true,
    },
  });

  if (rawJobs.length === 0) {
    throw new Response("Bulk run not found", { status: 404 });
  }

  const jobs: BulkJobItem[] = rawJobs.map((j) => {
    const meta = parseMeta(j.result);
    return {
      id: j.id,
      productId: j.productId,
      productTitle: j.productTitle ?? j.productId,
      status: j.status,
      errorMessage: j.errorMessage ?? null,
      bodyHtml: parseDraftHtml(j.result),
      metaTitle: meta?.meta_title ?? "",
      metaDescription: meta?.meta_description ?? "",
      keywords: meta?.keywords ?? [],
      socialCaption: meta?.social_caption ?? "",
      // We track "applied" by checking if generatedDescription is set (written to Shopify)
      appliedAt: j.generatedDescription ? j.updatedAt.toISOString() : null,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      vibe: j.vibe ?? "",
      format: j.format ?? "",
    };
  });

  const completedCount = jobs.filter((j) => j.status === "COMPLETED").length;
  const pendingCount = jobs.filter(
    (j) => j.status === "PENDING" || j.status === "PROCESSING",
  ).length;
  const failedCount = jobs.filter((j) => j.status === "FAILED").length;
  const appliedCount = jobs.filter((j) => j.appliedAt !== null).length;

  const data: BulkLoaderData = {
    bulkId,
    jobs,
    totalCount: jobs.length,
    completedCount,
    pendingCount,
    failedCount,
    appliedCount,
    shopDomain,
  };

  return json(data);
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const { admin, billing, shopDomain } = await requireAdminSession(request);

  const { bulkId } = params;
  if (!bulkId || !isUuid(bulkId)) {
    return json({ ok: false, error: "Invalid bulk ID" }, { status: 400 });
  }

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // ── apply_one ──────────────────────────────────────────────────────────────
  if (intent === "apply_one") {
    const jobId = String(fd.get("jobId") ?? "");
    if (!isUuid(jobId)) {
      return json({ ok: false, error: "Invalid jobId" }, { status: 400 });
    }

    const job = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain, bulkId, status: "COMPLETED" },
      select: { result: true, productId: true },
    });

    if (!job) {
      return json({ ok: false, error: "Job not found or not completed" }, { status: 404 });
    }

    const html = parseDraftHtml(job.result);
    if (!html) {
      return json({ ok: false, error: "No generated description to apply" }, { status: 422 });
    }

    const result = await applyDescriptionToShopify(admin.graphql, job.productId, html);
    if (!result.ok) {
      return json({ ok: false, error: result.error }, { status: 422 });
    }

    // Mark as applied by writing generatedDescription
    await db.generationJob.update({
      where: { id: jobId },
      data: { generatedDescription: html },
    });

    return json({ ok: true, intent: "apply_one", jobId });
  }

  // ── apply_all ─────────────────────────────────────────────────────────────
  if (intent === "apply_all") {
    const jobs = await db.generationJob.findMany({
      where: {
        bulkId,
        shopDomain,
        status: "COMPLETED",
        generatedDescription: null, // skip already-applied
      },
      select: { id: true, result: true, productId: true },
    });

    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        const html = parseDraftHtml(job.result);
        if (!html) return { id: job.id, ok: false, error: "No HTML" };

        const r = await applyDescriptionToShopify(admin.graphql, job.productId, html);
        if (r.ok) {
          await db.generationJob.update({
            where: { id: job.id },
            data: { generatedDescription: html },
          });
        }
        return { id: job.id, ...r };
      }),
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok,
    ).length;
    const failed = results.length - succeeded;

    return json({ ok: true, intent: "apply_all", succeeded, failed, total: jobs.length });
  }

  // ── retry_one ─────────────────────────────────────────────────────────────
  if (intent === "retry_one") {
    const jobId = String(fd.get("jobId") ?? "");
    if (!isUuid(jobId)) {
      return json({ ok: false, error: "Invalid jobId" }, { status: 400 });
    }
  const { appSubscriptions } = await billing.check();
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);
  const limitResult = await checkAndIncrementRateLimit(shopDomain, plan);
  
  if (!limitResult.allowed) {
    return json({ ok: false, error: "Too many generation requests. Please try again in a minute.", code: "RATE_LIMIT_EXCEEDED" }, { status: 429 });
  }


    const job = await db.generationJob.findFirst({
      where: { id: jobId, shopDomain, bulkId, status: "FAILED" },
      select: { id: true, productId: true, vibe: true, format: true, keywords: true, includeSocials: true },
    });

    if (!job) {
      return json({ ok: false, error: "Job not found or not failed" }, { status: 404 });
    }

    const creditRequestId = `${job.id}:retry:${crypto.randomUUID()}`;
    const credit = await deductCredits({
      shopId: shopDomain,
      plan,
      amount: CREDIT_COSTS.standardGeneration,
      requestId: creditRequestId,
      kind: "regeneration",
      metadata: { intent: "retry_one", jobId: job.id, productId: job.productId },
    });

    if (!credit.allowed) {
      return json(
        {
          ok: false,
          error: "Not enough credits",
          code: "INSUFFICIENT_CREDITS",
          creditsRemaining: credit.creditsRemaining,
          creditsLimit: credit.creditsLimit,
          resetDate: credit.resetDate.toISOString(),
        },
        { status: 402 },
      );
    }

    try {
      await db.generationJob.update({
        where: { id: jobId },
        data: {
          status: "PENDING",
          errorMessage: null,
          progress: 0,
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
        },
      });

      await generationQueue.add(
        `generate:${job.productId}`,
        {
          jobId: job.id,
          shopDomain,
          productId: job.productId,
          vibe: job.vibe,
          format: job.format,
          keywords: job.keywords,
          includeSocials: job.includeSocials,
          creditRequestId,
          creditCost: CREDIT_COSTS.standardGeneration,
          isStale: false
        },
        { ...generationJobDefaults, jobId: job.id },
      );
    } catch (err) {
      await refundCredits({
        shopId: shopDomain,
        plan,
        amount: CREDIT_COSTS.standardGeneration,
        requestId: `${creditRequestId}:retry-enqueue-error`,
        metadata: { intent: "retry_one", jobId: job.id, productId: job.productId },
      });
      throw err;
    }

    return json({ ok: true, intent: "retry_one", jobId });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}

export default BulkReviewPage;
