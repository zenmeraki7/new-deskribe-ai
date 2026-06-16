// FILE: app/components/diffViewer/SafeHtmlFrame.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, clampHtmlForAnalysis, clampIframeHeight } from "./limits";
import {
  buildKeywordRegexFromNormalized,
  countRegexMatches,
  normalizeKeywords,
} from "./keywords";

/**
 * SafeHtmlFrame (CLIENT-SIDE RENDERING SANDBOX)
 *
 * Security contract:
 * - This component is DISPLAY-ONLY and MUST NOT be a trust boundary for saving HTML.
 * - HTML is rendered inside a sandboxed iframe with a restrictive CSP.
 * - We still perform a *client-side allowlist sanitize* to reduce risk and improve stability,
 *   but the server MUST sanitize with an allowlist sanitizer before persisting.
 *
 * Key properties:
 * - No regex "sanitizers": sanitization is DOM-based with a tag/attr allowlist.
 * - No script execution: CSP blocks scripts; iframe sandbox excludes allow-scripts.
 * - Prevent JS URLs / event handlers / inline styles.
 * - Bound DOM work to avoid UI DoS.
 */

const IFRAME_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; margin: 0; padding: 0; color: #202223; }
  img { max-width: 100%; height: auto; }
  p { margin: 0 0 12px; }
  mark { background: #fff4e5; color: #202223; border: 1px solid #ffd6a4; border-radius: 2px; padding: 0 2px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #dfe3e8; padding: 6px 8px; vertical-align: top; }
`;

// CSP: block everything by default; allow inline styles (we embed CSS) and images via https.
// We explicitly block scripts and external navigation capabilities remain sandboxed.
const IFRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https:",
  "media-src https:",
  "font-src 'none'",
].join("; ");

// Conservative allowlist for rich-text content.
// IMPORTANT: Keep this tight; server should be the ultimate sanitizer.
const ALLOWED_TAGS = new Set([
  "P",
  "BR",
  "DIV",
  "SPAN",
  "STRONG",
  "B",
  "EM",
  "I",
  "U",
  "S",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "CODE",
  "HR",
  "A",
  "IMG",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
]);

// Allowed attributes by tag (global attrs intentionally minimal).
const ALLOWED_ATTRS = {
  A: new Set(["href", "title", "target", "rel"]),
  IMG: new Set(["src", "alt", "title", "width", "height"]),
  // Table cells: no styles; keep simple.
  TH: new Set(["colspan", "rowspan"]),
  TD: new Set(["colspan", "rowspan"]),
};

const GLOBAL_ALLOWED_ATTRS = new Set(["aria-label"]);

// Avoid runaway DOM sizes.
const MAX_ELEMENTS_FOR_PREVIEW = 20_000;

function isSafeUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;

  // Allow relative URLs.
  if (v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || v.startsWith("#")) {
    return true;
  }

  // Allow only https: (and mailto/tel for anchors).
  // NOTE: We intentionally disallow http: and data: here (safer default).
  try {
    const u = new URL(v, "https://example.invalid");
    const scheme = u.protocol.toLowerCase();
    if (scheme === "https:") return true;
    if (scheme === "mailto:" || scheme === "tel:") return true;
    return false;
  } catch {
    return false;
  }
}

function sanitizeDocAllowlist(doc) {
  const body = doc.body;
  if (!body) return;

  // Remove high-risk nodes quickly.
  body.querySelectorAll("script,style,noscript,iframe,object,embed,link,meta,base,form,svg,math").forEach((n) =>
    n.remove(),
  );

  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, null);
  /** @type {Element[]} */
  const nodes = [];

  let el = walker.nextNode();
  while (el) {
    nodes.push(/** @type {Element} */ (el));
    if (nodes.length > MAX_ELEMENTS_FOR_PREVIEW) break;
    el = walker.nextNode();
  }

  // If it's absurdly large, fall back to plain text rendering.
  if (nodes.length > MAX_ELEMENTS_FOR_PREVIEW) {
    const text = body.textContent ?? "";
    body.innerHTML = "";
    body.appendChild(doc.createTextNode(text));
    return;
  }

  for (const node of nodes) {
    const tag = node.tagName;

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap unknown tags to preserve content without keeping the element.
      const parent = node.parentNode;
      if (!parent) continue;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      continue;
    }

    // Strip disallowed attributes + all event handlers + inline styles.
    const allowedForTag = ALLOWED_ATTRS[tag] ?? null;

    // Copy to avoid live mutation issues.
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (name === "style" || name === "srcset") {
        node.removeAttribute(attr.name);
        continue;
      }

      const isGlobalAllowed = GLOBAL_ALLOWED_ATTRS.has(name);
      const isTagAllowed = allowedForTag ? allowedForTag.has(attr.name) : false;

      if (!isGlobalAllowed && !isTagAllowed) {
        node.removeAttribute(attr.name);
        continue;
      }

      // URL validation for href/src.
      if (tag === "A" && name === "href") {
        if (!isSafeUrl(value)) node.removeAttribute(attr.name);
      }

      if (tag === "IMG" && name === "src") {
        // Only allow https image sources (no data: by default).
        if (!isSafeUrl(value)) node.removeAttribute(attr.name);
      }
    }

    // Force safe link behavior.
    if (tag === "A") {
      // In sandboxed iframe without allow-top-navigation, links can't escape anyway,
      // but we still ensure safe rel semantics.
      const href = node.getAttribute("href");
      if (href) {
        const target = node.getAttribute("target");
        if (target !== "_blank") node.setAttribute("target", "_blank");
        const rel = (node.getAttribute("rel") ?? "").toLowerCase();
        const need = ["noopener", "noreferrer"];
        const next = new Set(rel.split(/\s+/g).filter(Boolean));
        for (const v of need) next.add(v);
        node.setAttribute("rel", Array.from(next).join(" "));
      } else {
        // If no href after sanitization, unwrap anchor.
        const parent = node.parentNode;
        if (parent) {
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        }
      }
    }

    // IMG: ensure alt exists (accessibility + prevents broken rendering oddities).
    if (tag === "IMG" && !node.hasAttribute("alt")) {
      node.setAttribute("alt", "");
    }
  }
}

function highlightHtmlWithKeywords(html, keywords) {
  const safeHtml = clampHtmlForAnalysis(html ?? "");
  if (!safeHtml) return "";

  // SSR: no DOMParser; return clamped content (still rendered in sandbox + CSP).
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return safeHtml;

  const safeKeywords = normalizeKeywords(keywords);
  if (!safeKeywords.length) {
    // Still sanitize allowlist for safety/stability before render.
    try {
      const doc = new DOMParser().parseFromString(safeHtml, "text/html");
      sanitizeDocAllowlist(doc);
      return doc.body?.innerHTML ?? safeHtml;
    } catch {
      return safeHtml;
    }
  }

  const re = buildKeywordRegexFromNormalized(safeKeywords);
  if (!re) {
    try {
      const doc = new DOMParser().parseFromString(safeHtml, "text/html");
      sanitizeDocAllowlist(doc);
      return doc.body?.innerHTML ?? safeHtml;
    } catch {
      return safeHtml;
    }
  }

  try {
    const doc = new DOMParser().parseFromString(safeHtml, "text/html");
    sanitizeDocAllowlist(doc);

    const body = doc.body;
    if (!body) return safeHtml;

    // Preflight match count cap to prevent extreme DOM work.
    const preText = body.textContent ?? "";
    const approxMatches = countRegexMatches(re, preText, LIMITS.MAX_KEYWORD_MATCHES_PER_DOC);
    if (approxMatches >= LIMITS.MAX_KEYWORD_MATCHES_PER_DOC) {
      // Too many matches; skip marking to keep UI responsive.
      return body.innerHTML;
    }

    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    let totalMarks = 0;

    for (const tn of textNodes) {
      const parentEl = tn.parentNode && tn.parentNode.nodeType === 1 ? tn.parentNode : null;
      const parentTag = parentEl?.tagName ? String(parentEl.tagName).toUpperCase() : "";
      if (parentTag === "SCRIPT" || parentTag === "STYLE") continue;

      const text = tn.nodeValue || "";
      if (!text.trim()) continue;

      re.lastIndex = 0;
      if (!re.test(text)) continue;

      re.lastIndex = 0;

      // Split preserves delimiters because regex has a capture group.
      const parts = text.split(re);
      if (parts.length <= 1) continue;

      const frag = doc.createDocumentFragment();

      for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
        if (!part) continue;

        const isMatch = idx % 2 === 1;
        if (isMatch) {
          totalMarks++;
          if (totalMarks > LIMITS.MAX_KEYWORD_MATCHES_PER_DOC) {
            frag.appendChild(doc.createTextNode(part));
            continue;
          }
          const mark = doc.createElement("mark");
          mark.textContent = part;
          frag.appendChild(mark);
        } else {
          frag.appendChild(doc.createTextNode(part));
        }
      }

      tn.parentNode?.replaceChild(frag, tn);
      if (totalMarks > LIMITS.MAX_KEYWORD_MATCHES_PER_DOC) break;
    }

    return body.innerHTML;
  } catch {
    return safeHtml;
  }
}

export function SafeHtmlFrame({ html, keywords, minHeight = LIMITS.MIN_IFRAME_HEIGHT }) {
  const [height, setHeight] = useState(clampIframeHeight(minHeight));
  const iframeRef = useRef(null);

  const srcDoc = useMemo(() => {
    const content = highlightHtmlWithKeywords(html, keywords);

    // Important: srcdoc is built from DOM-sanitized content and rendered in a sandboxed iframe.
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">
<meta name="referrer" content="no-referrer" />
<style>${IFRAME_CSS}</style>
</head>
<body>${content}</body>
</html>`;
  }, [html, keywords]);

  const updateHeight = useCallback(() => {
    try {
      const el = iframeRef.current;
      const body = el?.contentDocument?.body;
      if (!body) return;

      const raw = body.scrollHeight || clampIframeHeight(minHeight);
      const next = clampIframeHeight(raw + 20);
      setHeight(next);
    } catch {
      // Cross-origin or sandbox restrictions may block access; keep current height.
    }
  }, [minHeight]);

  useEffect(() => {
    const t = setTimeout(updateHeight, 50);
    return () => clearTimeout(t);
  }, [srcDoc, updateHeight]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      onLoad={updateHeight}
      // We keep allow-same-origin ONLY to measure height via contentDocument.
      // We do NOT allow scripts. CSP also blocks scripts.
      sandbox="allow-same-origin"
      style={{
        width: "100%",
        height,
        border: "none",
        display: "block",
        transition: "height 0.2s ease",
      }}
      // Important: do not expose any shop/product identifiers here.
      title="Preview"
    />
  );
}
