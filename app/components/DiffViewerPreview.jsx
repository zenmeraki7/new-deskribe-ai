// FILE: app/components/DiffViewerPreview.jsx
// Standalone interactive demo for the production DiffViewer component.
// Production component: app/components/DiffViewer.jsx
//
// SECURITY NOTE (DEMO-ONLY):
// - This preview parses keywords from a text input. Production keywords MUST come from
//   server-owned settings / versioned jobs (never trust client input for saves/apply).

import React, { useMemo, useState } from "react";
import DiffViewer from "./DiffViewer.jsx";
import { BEFORE_HTML, AFTER_HTML, DEFAULT_KEYWORDS } from "./diffViewerPreview/sampleData.js";
import { PreviewControls } from "./diffViewerPreview/PreviewControls.jsx";
import { normalizeKeywords } from "./DiffComponents/keywords.js";
import { clampSourceHtml } from "./DiffComponents/limits.js";

export default function DiffViewerPreview() {
  const [kwInput, setKwInput] = useState(DEFAULT_KEYWORDS.join(", "));
  const [showLoading, setShowLoading] = useState(false);
  const [showDraft, setShowDraft] = useState(true);
  const [showBefore, setShowBefore] = useState(true);

  const keywords = useMemo(() => {
    // Demo-only parsing. Production keywords should come from server-owned settings.
    const raw = String(kwInput ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Reuse production normalization/caps for realism and to prevent preview lockups.
    return normalizeKeywords(raw);
  }, [kwInput]);

  // Demo safety: clamp the sample HTML to preview-safe bounds (keeps preview snappy).
  const beforeHtml = useMemo(() => (showBefore ? clampSourceHtml(BEFORE_HTML) : ""), [showBefore]);
  const afterHtml = useMemo(() => (showDraft ? clampSourceHtml(AFTER_HTML) : ""), [showDraft]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "32px 24px",
        fontFamily: "system-ui,sans-serif",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0f172a" }}>
            DiffViewer — Component Preview
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#64748b" }}>
            Production component · <code style={{ fontSize: 12 }}>app/components/DiffViewer.jsx</code>
          </p>
        </div>

        <PreviewControls
          kwInput={kwInput}
          setKwInput={setKwInput}
          showDraft={showDraft}
          setShowDraft={setShowDraft}
          showBefore={showBefore}
          setShowBefore={setShowBefore}
          showLoading={showLoading}
          setShowLoading={setShowLoading}
        />

        <DiffViewer beforeHtml={beforeHtml} afterHtml={afterHtml} keywords={keywords} isLoading={showLoading} />

        <div
          style={{
            marginTop: 20,
            padding: "14px 18px",
            background: "#f1f5f9",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
          }}
        >
          <p style={{ margin: 0, fontSize: 12, color: "#475569", lineHeight: 1.7 }}>
            <strong>Drop-in usage:</strong> Replace your comparison UI with{" "}
            <code style={{ fontSize: 12 }}>
              {"<DiffViewer beforeHtml={currentHtml} afterHtml={draftHtml} keywords={keywords} isLoading={loading} />"}
            </code>
            . Visual mode renders HTML inside sandboxed <code>srcDoc</code> iframes (no scripts). For production, still
            sanitize on the server with an allowlist sanitizer and apply changes only via server-owned version/job IDs.
          </p>
        </div>
      </div>
    </div>
  );
}
