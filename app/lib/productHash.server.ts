import crypto from "node:crypto";

export type ProductSeoSnapshot = {
  title: string;
  handle: string;
  descriptionHtml: string;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
};

export function normalizeProductSnapshot(snapshot: ProductSeoSnapshot) {
  return {
    title: snapshot.title ?? "",
    handle: snapshot.handle ?? "",
    descriptionHtml: snapshot.descriptionHtml ?? "",
    tags: [...(snapshot.tags ?? [])].sort(),
    seoTitle: snapshot.seoTitle ?? "",
    seoDescription: snapshot.seoDescription ?? "",
  };
}

export function computeProductHash(snapshot: ProductSeoSnapshot) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeProductSnapshot(snapshot)))
    .digest("hex");
}

export function seoFieldsToSnapshot(
  current: ProductSeoSnapshot,
  fields: Record<string, unknown>,
): ProductSeoSnapshot {
  return {
    title: typeof fields.title === "string" ? fields.title : current.title,
    handle: typeof fields.handle === "string" ? fields.handle : current.handle,
    descriptionHtml:
      typeof fields.descriptionHtml === "string"
        ? fields.descriptionHtml
        : current.descriptionHtml,
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : current.tags,
    seoTitle:
      typeof fields.seoTitle === "string" ? fields.seoTitle : current.seoTitle,
    seoDescription:
      typeof fields.seoDescription === "string"
        ? fields.seoDescription
        : current.seoDescription,
  };
}
