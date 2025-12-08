// app/utils/sanitize.server.js
import DOMPurify from "isomorphic-dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const purify = DOMPurify(window);

export function sanitizeHTML(html) {
  if (!html) return "";
  return purify.sanitize(String(html), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "ul",
      "li",
      "strong",
      "b",
      "em",
      "i",
      "h1",
      "h2",
      "h3",
      "h4",
      "ol",
    ],
    ALLOWED_ATTR: [],
  });
}
