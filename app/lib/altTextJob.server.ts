// FILE: app/lib/altTextJob.server.ts
import crypto from "node:crypto";
import { db } from "./db.server";

export interface AltTextEntry {
  imageId: string;
  altText: string;
  applied: boolean;
  appliedAt: string | null;
}

export function extractAltTexts(result: unknown): AltTextEntry[] {
  if (!result || typeof result !== "object") return [];
  const arr = (result as any).alt_texts;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && typeof e.imageId === "string" && typeof e.altText === "string")
    .map((e) => ({
      imageId: e.imageId,
      altText: e.altText,
      applied: Boolean(e.applied),
      appliedAt: typeof e.appliedAt === "string" ? e.appliedAt : null,
    }));
}

function mergeEntries(
  existing: AltTextEntry[],
  incoming: { imageId: string; altText: string }[],
): AltTextEntry[] {
  const byId = new Map(existing.map((e) => [e.imageId, e]));
  for (const inc of incoming) {
    // Regenerating resets applied state — the drafted text has changed.
    byId.set(inc.imageId, { imageId: inc.imageId, altText: inc.altText, applied: false, appliedAt: null });
  }
  return Array.from(byId.values());
}

/**
 * Upserts alt-text drafts onto a single "alt_text_only" GenerationJob per
 * product, so re-generating drafts doesn't spawn a new History row each time,
 * and apply status can be tracked against one durable record.
 */
export async function upsertAltTextDrafts(params: {
  shopDomain: string;
  productId: string;
  productTitle: string;
  entries: { imageId: string; altText: string }[];
  creditRequestId: string;
  creditCost: number;
  bulkId?: string | null;
}): Promise<string> {
  const { shopDomain, productId, productTitle, entries, creditRequestId, creditCost, bulkId } = params;

  const existingJob = await db.generationJob.findFirst({
    where: { shopDomain, productId, vibe: "alt_text_only", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true },
  });

  if (existingJob) {
    const merged = mergeEntries(extractAltTexts(existingJob.result), entries);
    await db.generationJob.update({
      where: { id: existingJob.id },
      data: { result: { alt_texts: merged }, ...(bulkId ? { bulkId } : {}) },
    });
    return existingJob.id;
  }

  const created = await db.generationJob.create({
    data: {
      shopDomain,
      productId,
      productTitle,
      vibe: "alt_text_only",
      format: "alt_text_only",
      keywords: "",
      status: "COMPLETED",
      progress: 100,
      traceId: crypto.randomUUID(),
      inputHash: crypto.randomUUID(),
      includeSocials: false,
      creditRequestId,
      creditCost,
      bulkId: bulkId ?? null,
      result: {
        alt_texts: entries.map((e) => ({
          imageId: e.imageId,
          altText: e.altText,
          applied: false,
          appliedAt: null,
        })),
      },
    },
    select: { id: true },
  });

  return created.id;
}

/** Marks the given imageIds as applied across alt_text_only jobs (scoped to a product if given). */
export async function markAltTextApplied(params: {
  shopDomain: string;
  productId?: string;
  imageIds: string[];
}): Promise<void> {
  const { shopDomain, productId, imageIds } = params;
  if (imageIds.length === 0) return;
  const idSet = new Set(imageIds);

  const jobs = await db.generationJob.findMany({
    where: { shopDomain, vibe: "alt_text_only", status: "COMPLETED", ...(productId ? { productId } : {}) },
    select: { id: true, result: true },
  });

  const now = new Date().toISOString();

  for (const job of jobs) {
    const entries = extractAltTexts(job.result);
    let changed = false;
    const updated = entries.map((e) => {
      if (idSet.has(e.imageId) && !e.applied) {
        changed = true;
        return { ...e, applied: true, appliedAt: now };
      }
      return e;
    });
    if (changed) {
      await db.generationJob.update({ where: { id: job.id }, data: { result: { alt_texts: updated } } });
    }
  }
}