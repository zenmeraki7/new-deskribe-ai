// FILE: app/lib/ai.server.ts

import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const DraftSchema = z.object({
  body_html: z.string(),
  meta_title: z.string(),
  meta_description: z.string(),
  keywords: z.array(z.string().max(50)).max(30),
  social_caption: z.string().optional(),
});

export type DraftResult = z.infer<typeof DraftSchema>;

// ── Helper: strip markdown fences the AI sometimes wraps around JSON ──────────
function stripJsonFences(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function generateProductDescription(params: {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  vibe: string;
  format: string;
  keywords: string[];
  includeSocials: boolean;
}): Promise<DraftResult> {
  const {
    title,
    vendor,
    productType,
    tags,
    vibe,
    format,
    keywords,
    includeSocials,
  } = params;

  // Build the format instruction based on user's choice
  const formatInstruction =
    format === "bullets"
      ? "Use bullet points for ALL sections. No paragraphs."
      : format === "hybrid"
        ? "Use short paragraphs for intro and closing. Use bullet points for features."
        : "Use paragraphs throughout. No bullet points.";

  const socialsInstruction = includeSocials
    ? `Also generate a short, engaging Instagram caption with 3–5 relevant hashtags in "social_caption".`
    : `Set "social_caption" to an empty string.`;

  const prompt = `
You are an expert Shopify ecommerce copywriter.

Write a high-converting SEO-optimized product description.

Product Information:
- Title: ${title}
- Brand: ${vendor}
- Category: ${productType}
- Tags: ${tags.join(", ")}

Writing Style: ${vibe}
Format Rule: ${formatInstruction}
SEO Keywords to naturally include: ${keywords.length > 0 ? keywords.join(", ") : "none provided — infer from product info"}

STRUCTURE (always use these exact section headings):
1. <p><strong>Product Overview</strong></p> — 2–3 sentence engaging intro that naturally includes the primary keyword
2. <p><strong>Key Features</strong></p> followed by <ul><li> items (4–6 bullet points)
3. <p><strong>Why You'll Love It</strong></p> — persuasive closing paragraph encouraging purchase

HTML RULES:
- Use ONLY <p>, <ul>, <li>, <strong> tags
- No inline styles, no divs, no spans
- Wrap section headings in <p><strong>Heading</strong></p>

SEO RULES:
- meta_title: under 60 characters, include primary keyword
- meta_description: under 155 characters, compelling and keyword-rich
- keywords: up to 15 relevant SEO keywords as a JSON array of strings

${socialsInstruction}

Return ONLY valid JSON, no markdown, no explanation:
{
  "body_html": "...",
  "meta_title": "...",
  "meta_description": "...",
  "keywords": [],
  "social_caption": "..."
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.6,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an SEO copywriter for Shopify stores. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() ?? "";
  const text = stripJsonFences(raw);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("AI raw response (failed to parse):", raw);
    throw new Error("AI returned invalid JSON for description");
  }

  const parsed = DraftSchema.safeParse(json);
  if (!parsed.success) {
    console.error("Schema validation failed:", parsed.error.issues);
    throw new Error("Invalid AI output format");
  }

  return parsed.data;
}

// ── Keyword suggestion ─────────────────────────────────────────────────────────
export async function suggestKeywords(
  title: string,
  vendor: string,
  productType: string,
  tags: string[],
): Promise<string[]> {
  if (!title) return [];

  const prompt = `
Generate SEO keywords for a Shopify product listing.

Product Title: ${title}
Brand / Vendor: ${vendor}
Category / Type: ${productType}
Tags: ${tags.join(", ")}

Rules:
- Return ONLY a valid JSON array of strings
- No markdown, no explanation, no code fences
- Maximum 20 keywords
- Mix short-tail and long-tail keywords
- Include brand + category combinations

Example output:
["keyword one", "keyword two", "keyword three"]
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    // Note: NOT using response_format json_object here because we want a raw array
    messages: [
      {
        role: "system",
        content:
          "You generate SEO keyword lists. Always respond with a plain JSON array of strings only.",
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content ?? "[]";
  const text = stripJsonFences(raw);

  console.log("AI keyword response (cleaned):", text);

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    // Ensure all items are strings
    return parsed
      .filter((k): k is string => typeof k === "string")
      .slice(0, 20);
  } catch (err) {
    console.error("Suggest keyword parse error:", err, "Raw:", raw);
    throw new Error("AI returned invalid keyword format");
  }
}

// ── Bulk keyword suggestion ────────────────────────────────────────────────────
// Takes meta from multiple products, finds common themes, suggests shared keywords.
export async function suggestKeywordsBulk(products: {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
}[]): Promise<string[]> {
  if (products.length === 0) return [];

  // Build a compact product list for the prompt — avoid token bloat
  const productLines = products
    .slice(0, 50) // hard cap just in case
    .map((p, i) =>
      `${i + 1}. "${p.title}" | Brand: ${p.vendor || "unknown"} | Type: ${p.productType || "unknown"} | Tags: ${p.tags.slice(0, 8).join(", ") || "none"}`,
    )
    .join("\n");

  const prompt = `
You are an SEO expert for Shopify stores.

I am generating product descriptions for ${products.length} products in bulk.
Suggest SEO keywords that are relevant across this entire product collection.

Products:
${productLines}

Rules:
- Return ONLY a valid JSON array of strings
- No markdown, no explanation, no code fences
- Maximum 20 keywords
- Focus on shared themes, categories, and use cases across ALL products
- Include both short-tail (1-2 words) and long-tail (3-5 words) keywords
- Prioritize keywords a customer would use to find this type of product
- If products span multiple categories, include category-level keywords

Example output:
["keyword one", "keyword two", "keyword three"]
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: "You generate SEO keyword lists for product collections. Always respond with a plain JSON array of strings only.",
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content ?? "[]";
  const text = stripJsonFences(raw);

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((k): k is string => typeof k === "string")
      .slice(0, 20);
  } catch (err) {
    console.error("Bulk keyword suggestion parse error:", err, "Raw:", raw);
    throw new Error("AI returned invalid keyword format");
  }
}