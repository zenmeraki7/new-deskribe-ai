// FILE: app/components/diffViewerPreview/sampleData.js

/**
 * Demo sample data for DiffViewerPreview.
 *
 * SECURITY NOTE:
 * - This file is strictly for local preview/demo.
 * - Do NOT import or reuse this content in production flows.
 * - Production HTML must come from server-owned, sanitized, versioned data.
 */

// Keep sample HTML small and static to avoid accidental preview DoS.
export const BEFORE_HTML = `
<p>
  Introducing our classic <strong>cotton t-shirt</strong>.
  It is a good shirt that you can wear.
  The shirt comes in many colors and sizes.
  It is made from cotton and feels soft.
  Buy it today for your wardrobe.
  Good for everyday use.
</p>
`.trim();

export const AFTER_HTML = `
<p>
  Meet the <strong>organic cotton t-shirt</strong> your wardrobe has been waiting for —
  sustainably sourced, endlessly versatile, and built to last.
</p>

<ul>
  <li>
    100% <strong>GOTS-certified organic cotton</strong> — soft on skin, kind to the planet
  </li>
  <li>
    Pre-washed for a relaxed fit that keeps its shape wash after wash
  </li>
  <li>
    Available in 12 earth-toned shades, from slate to sage
  </li>
  <li>
    Unisex sizing XS–3XL for an inclusive fit
  </li>
</ul>

<p>
  Whether you're layering for the weekend or keeping it simple at the office,
  this <em>sustainable essential</em> does it all — without the environmental cost.
</p>
`.trim();

/**
 * Default preview keywords.
 * Must stay within production LIMITS:
 * - MAX_KEYWORDS
 * - MAX_KEYWORD_CHARS
 * - MAX_TOTAL_KEYWORD_CHARS
 */
export const DEFAULT_KEYWORDS = Object.freeze([
  "organic cotton",
  "sustainable",
  "GOTS-certified",
]);
