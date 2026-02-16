// import crypto from "crypto";
// import Redis from "ioredis";
// import { z } from "zod";
// import { sanitizeHTML } from "../utils/sanitize.server";

// /* ===========================
//    CONFIG
// =========================== */

// const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// const API_KEY = process.env.DEEPSEEK_API_KEY;
// const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
// const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

// const RATE_LIMIT_PER_MIN = Number(process.env.MAX_REQUESTS_PER_MINUTE ?? 30);
// const MONTHLY_LIMIT = Number(process.env.FREE_TIER_LIMIT ?? 150);

// if (!API_KEY) {
//   console.warn("⚠️ DeepSeek API key missing.");
// }

// /* ===========================
//    REDIS
// =========================== */

// const redis = new Redis(REDIS_URL, {
//   lazyConnect: true,
//   maxRetriesPerRequest: 1,
//   retryStrategy: (times) =>
//     times > 5 ? null : Math.min(times * 200, 2000),
// });

// /* ===========================
//    UTILITIES
// =========================== */

// const sha1 = (s) =>
//   crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// function cacheKey(payload) {
//   return `deepseek:v3:${sha1(JSON.stringify(payload))}`;
// }

// function usageKey(shop) {
//   return `deepseek:usage:${shop}:${new Date().toISOString().slice(0, 7)}`;
// }

// function rateKey(shop) {
//   return `deepseek:ratelimit:${shop}`;
// }

// /* ===========================
//    SCHEMAS
// =========================== */

// const DescriptionSchema = z.object({
//   description: z.string().min(20),
//   socials: z
//     .object({
//       twitter: z.string(),
//       instagram: z.string(),
//     })
//     .nullable(),
// });

// /* ===========================
//    SERVICE
// =========================== */

// export class DeepSeekService {
//   constructor() {
//     this.maxRetries = 3;
//     this.timeout = 20000;
//   }

//   /* ===========================
//      REDIS SAFE CONNECT
//   =========================== */

//   async ensureRedis() {
//     if (redis.status === "ready") return true;
//     try {
//       await redis.connect();
//       return true;
//     } catch {
//       return false;
//     }
//   }

//   /* ===========================
//      RATE + MONTHLY LIMIT
//   =========================== */

//   async checkRateLimit(shop) {
//     if (!shop) return;
//     if (!(await this.ensureRedis())) return;

//     const key = rateKey(shop);
//     const count = await redis.incr(key);
//     if (count === 1) await redis.expire(key, 60);

//     if (count > RATE_LIMIT_PER_MIN) {
//       throw new Error("Rate limit exceeded. Please wait.");
//     }
//   }

//   async checkMonthlyLimit(shop) {
//     if (!shop) return;
//     if (!(await this.ensureRedis())) return;

//     const key = usageKey(shop);
//     const used = Number((await redis.get(key)) ?? 0);

//     if (used >= MONTHLY_LIMIT) {
//       throw new Error(`Monthly limit reached (${used}/${MONTHLY_LIMIT})`);
//     }
//   }

//   async incrementUsage(shop) {
//     if (!shop) return;
//     if (!(await this.ensureRedis())) return;

//     const key = usageKey(shop);
//     await redis.incr(key);

//     const now = new Date();
//     const nextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);
//     const ttl = Math.floor((nextMonth.getTime() - now.getTime()) / 1000);

//     await redis.expire(key, ttl);
//   }

//   /* ===========================
//      PUBLIC: DESCRIPTION
//   =========================== */

//   async generateDescription({
//     product,
//     vibe = "casual",
//     format = "paragraph",
//     keywords = "",
//     includeSocials = false,
//     shop,
//   }) {
//     if (!product?.title) {
//       throw new Error("Product title required");
//     }

//     await this.checkRateLimit(shop);
//     await this.checkMonthlyLimit(shop);

//     const prompt = this.buildPrompt({
//       product,
//       vibe,
//       format,
//       keywords,
//       includeSocials,
//     });

//     const key = cacheKey({ prompt });

//     if (await this.ensureRedis()) {
//       const cached = await redis.get(key);
//       if (cached) return JSON.parse(cached);
//     }

//     const raw = await this.callJSONModel(prompt);
//     const parsed = DescriptionSchema.parse(raw);

//     parsed.description = sanitizeHTML(parsed.description);

// if (
//   parsed.description.length < 120 ||
//   /test|sample|placeholder|new value product/i.test(parsed.description)
// ) {
//   throw new Error("Low-quality AI output rejected");
// }


//     if (await this.ensureRedis()) {
//       await redis.setex(key, 86400, JSON.stringify(parsed));
//     }

//     await this.incrementUsage(shop);

//     return parsed;
//   }

//   /* ===========================
//      PUBLIC: SEO KEYWORDS
//   =========================== */

//   async generateSEOKeywords({ product, vibe }) {
//     const prompt = `
// You are an expert Shopify SEO strategist.

// Suggest 8 high-intent SEO keywords.

// Tone: ${vibe}
// Title: ${product?.title}
// Description: ${product?.description ?? ""}

// Return ONLY comma-separated keywords.
// `;

//     const text = await this.callTextModel(prompt);

//     return text
//       .split(",")
//       .map((k) => k.trim())
//       .filter(Boolean)
//       .slice(0, 8);
//   }

//   /* ===========================
//      JSON MODEL CALL
//   =========================== */

//   async callJSONModel(prompt) {
//     let lastError;

//     for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
//       try {
//         const response = await this._fetch(prompt, 0.65);

//         const content =
//           response?.choices?.[0]?.message?.content ??
//           response?.choices?.[0]?.text ??
//           "";

//         const cleaned = content.replace(/```(json)?/gi, "").trim();

//         try {
//           return JSON.parse(cleaned);
//         } catch {}

//         const start = cleaned.indexOf("{");
//         if (start !== -1) {
//           let depth = 0;
//           for (let i = start; i < cleaned.length; i++) {
//             if (cleaned[i] === "{") depth++;
//             if (cleaned[i] === "}") {
//               depth--;
//               if (depth === 0) {
//                 const candidate = cleaned.slice(start, i + 1);
//                 return JSON.parse(candidate);
//               }
//             }
//           }
//         }

//         throw new Error("Invalid JSON returned from AI");
//       } catch (err) {
//         lastError = err;
//         if (attempt < this.maxRetries) {
//           await sleep(400 * attempt);
//         }
//       }
//     }

//     throw new Error(
//       `AI JSON parsing failed: ${lastError?.message}`
//     );
//   }

//   async callTextModel(prompt) {
//     const response = await this._fetch(prompt, 0.7);

//     return (
//       response?.choices?.[0]?.message?.content ??
//       response?.choices?.[0]?.text ??
//       ""
//     );
//   }

//   /* ===========================
//      FETCH CORE
//   =========================== */

//   async _fetch(prompt, temperature = 0.7) {
//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), this.timeout);

//     try {
//       const res = await fetch(`${BASE_URL}/chat/completions`, {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${API_KEY}`,
//         },
//         body: JSON.stringify({
//           model: MODEL,
//           temperature,
//           max_tokens: 1200,
//           messages: [
//             {
//               role: "system",
//               content: `
// You are a senior Shopify e-commerce conversion copywriter.

// Rules:
// - Write high-converting, benefit-driven product descriptions.
// - NEVER use placeholder text.
// - NEVER repeat the product title unnecessarily.
// - NEVER mention "test", "sample", "example", or debugging words.
// - Focus on value, transformation, and customer benefit.
// - Use persuasive but natural language.
// - Output MUST be strictly valid JSON.
// - No markdown.
// - No explanations.
// - No code fences.
// If output is not valid JSON, the response will be rejected.
// `,

//             },
//             { role: "user", content: prompt },
//           ],
//         }),
//         signal: controller.signal,
//       });

//       if (!res.ok) {
//         const errorText = await res.text();
//         throw new Error(`DeepSeek HTTP ${res.status}: ${errorText}`);
//       }

//       return await res.json();
//     } finally {
//       clearTimeout(timeout);
//     }
//   }

//   /* ===========================
//      PROMPT ENGINE
//   =========================== */

//   buildPrompt({ product, vibe, format, keywords, includeSocials }) {
//     const metafields = Array.isArray(product.metafields)
//       ? product.metafields
//           .map((m) => `${m.node?.key}: ${m.node?.value}`)
//           .join(", ")
//       : "None";

//     const vibeMap = {
//       edgy: "Bold, punchy, high-conversion tone.",
//       minimalist: "Clean, direct, concise.",
//       casual: "Friendly, warm, conversational.",
//       luxury: "Premium, aspirational, refined.",
//       professional: "Authoritative and benefit-focused.",
//       roast: "Playfully blunt but persuasive.",
//     };

//     const formatMap = {
//       paragraph:
//         "Return 2-3 paragraphs using <p> tags only.",
//       bullets:
//         "Return <p> intro + <ul><li>4-6 benefits</li></ul> + closing <p>.",
//       short:
//         "Return one strong <p> with 2-3 sentences.",
//     };

//     return `
// PRODUCT:
// Title: ${product.title}
// Type: ${product.productType ?? ""}
// Vendor: ${product.vendor ?? ""}
// Tags: ${Array.isArray(product.tags) ? product.tags.join(", ") : ""}
// Metafields: ${metafields}
// Existing Description: ${product.description ?? "None"}

// Tone: ${vibeMap[vibe] ?? vibeMap.casual}
// Format: ${formatMap[format] ?? formatMap.paragraph}
// ${keywords ? `SEO Keywords: ${keywords}` : ""}

// Write a persuasive, benefit-driven product description.
// Focus on:
// - Customer pain points
// - Emotional triggers
// - Clear value proposition
// - Specific outcomes

// Do NOT:
// - Use generic phrases
// - Mention that this is AI-generated
// - Use filler content
// - Repeat input text mechanically

// You MUST return ONLY a valid JSON object.
// No markdown.
// No code blocks.
// No explanations.


// Return EXACTLY this structure:

// {
//   "description": "<p>HTML description here...</p>",
//   ${
//     includeSocials
//       ? `"socials": { "instagram": "...", "twitter": "..." }`
//       : `"socials": null`
//   }
// }
// `;
//   }
// }

// export const deepseek = new DeepSeekService();
