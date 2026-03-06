// FILE: app/lib/ai.server.ts

import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/*
Schema that matches your UI DraftResult expectations
*/
export const DraftSchema = z.object({
  body_html: z.string(),
  meta_title: z.string(),
  meta_description: z.string(),
  keywords: z.array(z.string()).max(30),
  social_caption: z.string().optional(),
});

export type DraftResult = z.infer<typeof DraftSchema>;

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

  const prompt = `
You are an expert Shopify ecommerce copywriter.

Write a high-converting SEO optimized product description.

Product Information:
Title: ${title}
Brand: ${vendor}
Category: ${productType}
Tags: ${tags.join(", ")}

Writing Style: ${vibe}
Format: ${format}

SEO Keywords:
${keywords.join(", ")}

RULES:

1. Output must be VALID JSON
2. Do NOT include explanations
3. body_html must contain clean HTML
4. Use <p>, <ul>, <li>, <strong> tags
5. Description must be persuasive and SEO optimized
6. Keep meta_title under 60 characters
7. Keep meta_description under 155 characters
8. Generate up to 15 keywords

FORMAT:

{
"body_html": "",
"meta_title": "",
"meta_description": "",
"keywords": [],
"social_caption": ""
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.6,
    messages: [
      {
        role: "system",
        content: "You write SEO optimized ecommerce product descriptions.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = completion.choices[0].message.content ?? "";

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("AI returned invalid JSON");
  }

  const parsed = DraftSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error("Invalid AI output format");
  }

  return parsed.data;
}

/*
Keyword suggestion for your Suggest button
*/
export async function suggestKeywords(
  title: string,
  vendor: string,
  productType: string,
  tags: string[],
): Promise<string[]> {

  if (!title) return [];

  const prompt = `
Generate SEO keywords for a Shopify product.

Title: ${title}
Brand: ${vendor}
Category: ${productType}
Tags: ${tags.join(", ")}

Return ONLY a JSON array of keywords.
Max 20 keywords.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: "You generate ecommerce SEO keywords." },
        { role: "user", content: prompt },
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "[]";

    console.log("AI keyword response:", text);

    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed)) return [];

    return parsed.slice(0, 20);

  } catch (err) {
    console.error("Suggest keyword AI error:", err);
    throw err;
  }
}