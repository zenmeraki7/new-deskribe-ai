// FILE: app/lib/bulkJob.server.ts
//
// Shared helpers + types for reading generation job records into the shape
// the UI expects. Used by the full bulk review loader and the on-demand
// single-job API route so this parsing logic only lives in one place.

import { sanitiseHtml } from "./html.server";

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

export function parseDraftHtml(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const raw = (result as any).body_html ?? "";
  if (typeof raw !== "string") return "";
  return sanitiseHtml(raw);
}

export function parseMeta(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const r = result as any;
  return {
    meta_title: typeof r.meta_title === "string" ? r.meta_title : "",
    meta_description: typeof r.meta_description === "string" ? r.meta_description : "",
    keywords: Array.isArray(r.keywords)
      ? r.keywords.filter((k: unknown): k is string => typeof k === "string")
      : [],
    social_caption: typeof r.social_caption === "string" ? r.social_caption : "",
  };
}

/** Maps a raw db row into the shape the UI renders. */
export function toBulkJobItem(row: {
  id: string;
  productId: string;
  productTitle: string | null;
  status: string;
  errorMessage: string | null;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
  vibe: string | null;
  format: string | null;
  generatedDescription: string | null;
}): BulkJobItem {
  const meta = parseMeta(row.result);
  return {
    id: row.id,
    productId: row.productId,
    productTitle: row.productTitle ?? row.productId,
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    bodyHtml: parseDraftHtml(row.result),
    metaTitle: meta?.meta_title ?? "",
    metaDescription: meta?.meta_description ?? "",
    keywords: meta?.keywords ?? [],
    socialCaption: meta?.social_caption ?? "",
    appliedAt: row.generatedDescription ? row.updatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    vibe: row.vibe ?? "",
    format: row.format ?? "",
  };
}