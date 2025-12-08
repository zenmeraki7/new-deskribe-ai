// app/services/deepseek.server.js
import crypto from "crypto";
import Redis from "ioredis";
import { sanitizeHTML } from "../utils/sanitize.server"; 

/**
 * DeepSeekService
 * - Uses DeepSeek HTTP endpoint (OpenAI-compatible).
 * - Optional Redis caching (lazy connect).
 * - Per-shop rate limits and monthly usage tracking.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const RATE_LIMIT_PER_MIN = parseInt(process.env.MAX_REQUESTS_PER_MINUTE ?? "30", 10);
const MONTHLY_LIMIT = parseInt(process.env.FREE_TIER_LIMIT ?? "150", 10);

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
});

// Do NOT call redis.connect() during module load — keep optional.
// We'll attempt to connect lazily when we first need Redis.

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function normalizeMetafields(product) {
  try {
    if (!product) return [];
    if (Array.isArray(product.metafields)) return product.metafields;
    const edges = product.metafields?.edges;
    if (Array.isArray(edges)) {
      return edges.map((e) => {
        const node = e.node ?? e;
        if (typeof node.value === "string") return `${node.key}: ${node.value}`;
        return `${node.key}: ${JSON.stringify(node.value)}`;
      });
    }
  } catch (e) {
    // ignore
  }
  return [];
}

function buildCacheKey({ productId, vibe, format, keywords, includeSocials }) {
  const small = sha1(`${productId}|${vibe}|${format}|${keywords ?? ""}|${includeSocials}`);
  return `deepseek:cache:${small}`;
}

function usageKey(shop) {
  return `deepseek:usage:${shop}:${new Date().toISOString().slice(0, 7)}`;
}

function rateLimitKey(shop) {
  return `deepseek:ratelimit:${shop}`;
}

// Extract JSON safely from AI text: prefer strict JSON block, fallback to naive parse
function extractJsonFromText(text) {
  if (!text || typeof text !== "string") throw new Error("Empty response");
  const cleaned = text.replace(/```(json)?/g, "").trim();

  // Direct JSON first
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Greedy find balanced {...} block (stop after first reasonable block to avoid O(n^2))
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in AI response");

  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          // try to continue searching if parse fails
        }
      }
    }
  }

  // final fallback: regex match
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  throw new Error("Could not extract valid JSON from AI response");
}

export class DeepSeekService {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? DEEPSEEK_BASE;
    this.apiKey = opts.apiKey ?? DEEPSEEK_API_KEY;
    this.model = opts.model ?? "deepseek-chat";
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeout = opts.timeout ?? 25_000;
  }

  async _ensureRedis() {
    if (redis.status === "ready") return true;
    try {
      await redis.connect();
      return true;
    } catch (err) {
      console.warn("Redis unavailable:", err?.message ?? err);
      return false;
    }
  }

  async checkRateLimit(shop) {
    if (!shop) return { allowed: true, remaining: RATE_LIMIT_PER_MIN };
    if (!(await this._ensureRedis())) return { allowed: true, remaining: RATE_LIMIT_PER_MIN };

    try {
      const key = rateLimitKey(shop);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > RATE_LIMIT_PER_MIN) return { allowed: false, remaining: 0 };
      return { allowed: true, remaining: RATE_LIMIT_PER_MIN - count };
    } catch (err) {
      console.warn("Rate limit check failed:", err?.message ?? err);
      return { allowed: true, remaining: RATE_LIMIT_PER_MIN };
    }
  }

  async checkMonthlyLimit(shop) {
    if (!shop) return { allowed: true, used: 0, limit: MONTHLY_LIMIT };
    if (!(await this._ensureRedis())) return { allowed: true, used: 0, limit: MONTHLY_LIMIT };

    try {
      const key = usageKey(shop);
      const used = parseInt((await redis.get(key)) ?? "0", 10);
      if (used >= MONTHLY_LIMIT) return { allowed: false, used, limit: MONTHLY_LIMIT };
      return { allowed: true, used, limit: MONTHLY_LIMIT };
    } catch (err) {
      console.warn("Monthly usage check failed:", err?.message ?? err);
      return { allowed: true, used: 0, limit: MONTHLY_LIMIT };
    }
  }

  async incrementUsage(shop, increment = 1) {
    if (!shop) return;
    if (!(await this._ensureRedis())) return;
    try {
      const key = usageKey(shop);
      await redis.incrby(key, increment);
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth() + 2, 1);
      const ttl = Math.floor((next.getTime() - now.getTime()) / 1000);
      await redis.expire(key, ttl);
    } catch (err) {
      console.warn("incrementUsage failed:", err?.message ?? err);
    }
  }

  async generateDescription({ product, vibe = "edgy", format = "paragraph", keywords = "", includeSocials = false, shop = null } = {}) {
    const rl = await this.checkRateLimit(shop);
    if (!rl.allowed) throw new Error("Rate limit exceeded. Try again shortly.");

    const ml = await this.checkMonthlyLimit(shop);
    if (!ml.allowed) throw new Error(`Monthly limit reached: ${ml.used}/${ml.limit}`);

    const cacheKey = buildCacheKey({ productId: product?.id ?? "unknown", vibe, format, keywords, includeSocials });
    const haveRedis = await this._ensureRedis();
    if (haveRedis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          try {
            return JSON.parse(cached);
          } catch {}
        }
      } catch (e) {
        // ignore cache errors
      }
    }

    const prompt = this.buildPrompt({ product, vibe, format, keywords, includeSocials });

    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this._callDeepSeekHTTP(prompt);

        if (result?.description) result.description = sanitizeHTML(String(result.description));
        if (haveRedis) {
          try {
            await redis.setex(cacheKey, 60 * 60 * 24, JSON.stringify(result));
          } catch (e) {}
        }
        if (shop) await this.incrementUsage(shop);
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) await sleep(500 * attempt);
      }
    }

    throw new Error(`Generation failed: ${lastErr?.message ?? "unknown error"}`);
  }

  async _callDeepSeekHTTP(prompt) {
    if (!this.apiKey) throw new Error("DeepSeek API key is not configured");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: "You are an expert e-commerce copywriter. Return valid JSON only." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 1500,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`DeepSeek HTTP ${res.status}: ${txt}`);
      }

      const payload = await res.json().catch(async () => {
        const txt = await res.text();
        return { rawText: txt };
      });

      let aiText = null;
      if (payload?.choices?.[0]?.message?.content) aiText = payload.choices[0].message.content;
      else if (payload?.choices?.[0]?.text) aiText = payload.choices[0].text;
      else if (payload?.rawText) aiText = payload.rawText;
      else aiText = JSON.stringify(payload);

      const parsed = extractJsonFromText(String(aiText));

      if (!parsed || typeof parsed !== "object") throw new Error("AI returned invalid JSON object");
      if (!("description" in parsed)) parsed.description = "";
      if (!("socials" in parsed)) parsed.socials = null;

      return parsed;
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("DeepSeek request timed out");
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  buildPrompt({ product, vibe, format, keywords, includeSocials } = {}) {
    const title = product?.title ?? "Untitled";
    const oldDescription = (product?.description ?? "").replace(/\n/g, " ");
    const metafieldsArray = normalizeMetafields(product);
    const metafields = metafieldsArray.length ? metafieldsArray.join(", ") : "None";

    const vibeMap = {
      edgy: "Bold. Punchy. Minimal fluff.",
      minimalist: "Ultra concise. Functional. No adjectives.",
      roast: "Real Talk. Brutally honest. Persuasive, not rude.",
    };

    const formatMap = {
      paragraph: "Return HTML paragraphs using <p> tags (2-3 short paragraphs).",
      bullets: "Return an unordered list using <ul><li> ... </li></ul> with 4-6 concise bullets.",
    };

    const instructions = [
      `Title: ${title}`,
      `Meta: ${metafields}`,
      `Old Description: ${oldDescription || "None"}`,
      `Tone: ${vibeMap[vibe] ?? vibeMap.edgy}`,
      `Format: ${formatMap[format] ?? formatMap.paragraph}`,
      keywords ? `SEO Keywords: ${keywords}` : "",
      includeSocials ? "Also generate a 'socials' object with keys 'twitter' and 'instagram'." : "",
      "",
      "RETURN: Only valid JSON object with exactly these keys:",
      `{
  "description": "<p>HTML product description here...</p>",
  "socials": { "twitter": "...", "instagram": "..." }  // or null
}`,
      "Do NOT include Markdown fenced code blocks. Do NOT include any explanation text. Just return JSON.",
    ].filter(Boolean).join("\n");

    return instructions;
  }
}

export const deepseek = new DeepSeekService();
