import crypto from "crypto";
import Redis from "ioredis";
import { z } from "zod";
import { sanitizeHTML } from "../utils/sanitize.server";

/* ===========================
   CONFIG
=========================== */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

const RATE_LIMIT_PER_MIN = Number(process.env.MAX_REQUESTS_PER_MINUTE ?? 30);
const MONTHLY_LIMIT = Number(process.env.FREE_TIER_LIMIT ?? 150);

if (!API_KEY) {
  console.warn("⚠️ DeepSeek API key missing.");
}

/* ===========================
   REDIS (Lazy + Safe)
=========================== */

const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
});

/* ===========================
   UTILITIES
=========================== */

const sha1 = (s) =>
  crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheKey(payload) {
  return `deepseek:v1:${sha1(JSON.stringify(payload))}`;
}

function usageKey(shop) {
  return `deepseek:usage:${shop}:${new Date().toISOString().slice(0, 7)}`;
}

function rateKey(shop) {
  return `deepseek:ratelimit:${shop}`;
}

/* ===========================
   SCHEMAS
=========================== */

const DescriptionSchema = z.object({
  description: z.string().min(20),
  socials: z
    .object({
      twitter: z.string(),
      instagram: z.string(),
    })
    .nullable(),
});

/* ===========================
   SERVICE
=========================== */

export class DeepSeekService {
  constructor() {
    this.maxRetries = 3;
    this.timeout = 20000;
  }

  /* ===========================
     REDIS SAFE CONNECT
  =========================== */

  async ensureRedis() {
    if (redis.status === "ready") return true;
    try {
      await redis.connect();
      return true;
    } catch {
      return false;
    }
  }

  /* ===========================
     RATE LIMIT
  =========================== */

  async checkRateLimit(shop) {
    if (!shop) return;

    if (!(await this.ensureRedis())) return;

    const key = rateKey(shop);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);

    if (count > RATE_LIMIT_PER_MIN) {
      throw new Error("Rate limit exceeded. Please wait.");
    }
  }

  async checkMonthlyLimit(shop) {
    if (!shop) return;

    if (!(await this.ensureRedis())) return;

    const key = usageKey(shop);
    const used = Number((await redis.get(key)) ?? 0);

    if (used >= MONTHLY_LIMIT) {
      throw new Error(`Monthly limit reached (${used}/${MONTHLY_LIMIT})`);
    }
  }

  async incrementUsage(shop) {
    if (!shop) return;
    if (!(await this.ensureRedis())) return;

    const key = usageKey(shop);
    await redis.incr(key);

    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const ttl = Math.floor((nextMonth - now) / 1000);

    await redis.expire(key, ttl);
  }

  /* ===========================
     PUBLIC METHODS
  =========================== */

  async generateDescription({
    product,
    vibe = "casual",
    format = "paragraph",
    keywords = "",
    includeSocials = false,
    shop,
  }) {
    // Validate input
    if (!product || !product.title) {
      throw new Error("Product data is required with at least a title");
    }

    await this.checkRateLimit(shop);
    await this.checkMonthlyLimit(shop);

    // Enhance product object with additional fields if available
    const enhancedProduct = {
      ...product,
      productType: product.productType || "",
      vendor: product.vendor || "",
      tags: product.tags || [],
    };

    const prompt = this.buildPrompt({
      product: enhancedProduct,
      vibe,
      format,
      keywords,
      includeSocials,
    });

    const key = cacheKey({ prompt });

    if (await this.ensureRedis()) {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached);
    }

    const raw = await this.callJSONModel(prompt);

    const parsed = DescriptionSchema.parse(raw);

    parsed.description = sanitizeHTML(parsed.description);

    if (await this.ensureRedis()) {
      await redis.setex(key, 86400, JSON.stringify(parsed));
    }

    await this.incrementUsage(shop);

    return parsed;
  }

  async generateSEOKeywords({ product, vibe }) {
    // Validate input
    if (!product) {
      throw new Error("Product data is required");
    }

    const productTitle = product?.title || "Unknown Product";
    const productDesc = product?.description || "";
    
    const prompt = `
You are an SEO expert.

Suggest 8 high-intent Shopify SEO keywords.

Tone: ${vibe}
Title: ${productTitle}
Description: ${productDesc}

Return ONLY comma-separated keywords.
`;

    const text = await this.callTextModel(prompt);

    return text
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  /* ===========================
     MODEL CALLS
  =========================== */

  async callJSONModel(prompt) {
    try {
      const response = await this._fetch(prompt);

      const content =
        response?.choices?.[0]?.message?.content ??
        response?.choices?.[0]?.text ??
        "";

      try {
        return JSON.parse(content);
      } catch (parseError) {
        console.error("Failed to parse JSON response:", content);
        // Fallback to a simple description if JSON parsing fails
        return {
          description: content.replace(/[{}"]/g, '').trim(),
          socials: null
        };
      }
    } catch (error) {
      console.error("API call failed:", error);
      throw new Error("Failed to generate description. Please try again.");
    }
  }

  async callTextModel(prompt) {
    try {
      const response = await this._fetch(prompt);

      return (
        response?.choices?.[0]?.message?.content ??
        response?.choices?.[0]?.text ??
        ""
      );
    } catch (error) {
      console.error("API call failed:", error);
      throw new Error("Failed to generate keywords. Please try again.");
    }
  }

  async _fetch(prompt, temperature = 0.7) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: temperature,
          max_tokens: 1000,
          messages: [
            {
              role: "system",
              content:
                "You are an expert e-commerce copywriter. Create compelling product descriptions that convert browsers into buyers.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`DeepSeek HTTP ${res.status}: ${errorText}`);
      }

      return await res.json();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - AI service took too long to respond');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ===========================
     PROMPT ENGINE
  =========================== */

  buildPrompt({ product, vibe, format, keywords, includeSocials }) {
    // Enhanced vibe mapping with detailed instructions
    const vibeMap = {
      edgy: `Tone: Bold, punchy, rebellious, high-conversion
Style: Use powerful action words, create urgency, appeal to trendsetters
Example words: "rebel", "stand out", "edgy", "bold", "unapologetic"`,
      
      minimalist: `Tone: Clean, direct, functional, sophisticated
Style: Focus on quality, simplicity, timeless appeal, use short sentences
Example words: "essential", "timeless", "pure", "effortless", "curated"`,
      
      casual: `Tone: Friendly, approachable, warm, conversational
Style: Write like a friend recommending the product, use "you" and "your"
Example words: "comfy", "everyday", "easy", "perfect for", "love"`,
      
      luxury: `Tone: Sophisticated, premium, exclusive, aspirational
Style: Emphasize quality, craftsmanship, exclusivity, use elegant language
Example words: "exquisite", "premium", "artisan", "luxurious", "exceptional"`,
      
      professional: `Tone: Authoritative, trustworthy, informative, polished
Style: Focus on benefits, specifications, professional value
Example words: "professional", "high-performance", "durable", "reliable"`,
      
      roast: `Tone: Playfully blunt, humorous, persuasive, relatable
Style: Use wit and humor, poke gentle fun at common problems
Example words: "let's be real", "truth is", "admit it", "game changer"`
    };

    // Enhanced format mapping with specific HTML structure
    const formatMap = {
      paragraph: `Format: Write 2-3 engaging paragraphs using <p> tags
Structure:
- First paragraph: Hook + main benefit
- Second paragraph: Features/details
- Third paragraph: Call to action or closing thought`,
      
      bullets: `Format: Use bullet points with <ul> and <li> tags
Structure:
- Opening sentence in <p> tag
- 4-6 key benefits as bullet points
- Closing sentence in <p> tag with call to action`,
      
      short: `Format: Concise, punchy description
Structure:
- One powerful <p> tag with 2-3 sentences
- Focus on unique selling proposition
- Strong call to action`
    };

    // Extract product details safely
    const productTitle = product.title || "Unknown Product";
    const productDesc = product.description || "";
    const productType = product.productType || "";
    const vendor = product.vendor || "";
    const tags = Array.isArray(product.tags) ? product.tags.join(", ") : "";

    return `
You are an expert e-commerce copywriter specializing in Shopify product descriptions.

**PRODUCT DETAILS:**
Title: ${productTitle}
Type: ${productType}
Vendor/Brand: ${vendor}
Tags: ${tags}
Current Description: ${productDesc || "No existing description"}

**WRITING GUIDELINES:**
${vibeMap[vibe] || vibeMap.casual}

${formatMap[format] || formatMap.paragraph}

${keywords ? `**SEO KEYWORDS TO INCLUDE:** ${keywords}` : ''}

**REQUIREMENTS:**
- Write compelling, conversion-focused copy
- Highlight benefits, not just features
- Use natural language that resonates with the target audience
- Include relevant emojis sparingly (max 2-3) if appropriate for the vibe
- Make it scannable and easy to read
- Focus on what makes this product special

${includeSocials ? `**SOCIAL MEDIA POSTS:**
- Instagram caption: Engaging, visual-focused, with relevant hashtags
- Twitter/X post: Concise, punchy, click-worthy` : ''}

Return ONLY valid JSON in this exact format:
{
  "description": "<p>Your engaging opening paragraph here...</p><p>More details and benefits here...</p>",
  ${includeSocials ? 
    '"socials": { "instagram": "Your Instagram caption with emojis and hashtags", "twitter": "Your Twitter/X post (max 280 chars)" }' : 
    '"socials": null'
  }
}

No explanations, no markdown, no backticks. Return ONLY the JSON object.
`;
  }

  /* ===========================
     UTILITY METHODS
  =========================== */

  detectProductCategory(title, type, tags) {
    const categories = {
      clothing: ['shirt', 'pant', 'dress', 'jacket', 'jeans', 'hoodie', 'sweater', 'skirt', 'blouse', 't-shirt'],
      jewelry: ['necklace', 'ring', 'bracelet', 'earring', 'pendant', 'chain', 'bangle'],
      home: ['furniture', 'decor', 'pillow', 'blanket', 'lamp', 'rug', 'curtain', 'vase'],
      beauty: ['makeup', 'skincare', 'cream', 'lotion', 'serum', 'lipstick', 'foundation', 'mask'],
      electronics: ['phone', 'laptop', 'tablet', 'charger', 'headphone', 'speaker', 'cable'],
      accessories: ['bag', 'wallet', 'belt', 'hat', 'scarf', 'glove', 'sunglass']
    };
    
    const text = `${title} ${type} ${tags}`.toLowerCase();
    
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => text.includes(keyword))) {
        return category;
      }
    }
    return 'general';
  }

  validateDescription(description, product) {
    // Check if description mentions the product title or key attributes
    const titleWords = product.title.toLowerCase().split(' ');
    const descLower = description.toLowerCase();
    
    const mentionsProduct = titleWords.some(word => 
      word.length > 3 && descLower.includes(word)
    );
    
    if (!mentionsProduct) {
      console.warn("⚠️ Generated description doesn't mention product title");
    }
    
    return mentionsProduct;
  }
}

export const deepseek = new DeepSeekService();