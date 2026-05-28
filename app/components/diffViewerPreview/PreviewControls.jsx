// FILE: app/components/diffViewerPreview/PreviewControls.jsx
import React, { useCallback } from "react";
import { Card, InlineStack, TextField, Button, Checkbox, BlockStack } from "@shopify/polaris";

/**
 * PreviewControls (DEMO-ONLY)
 *
 * Security contract:
 * - Demo UI only. Must never be reused in production flows for saving/applying content.
 * - Keyword input is for preview rendering only.
 */

function ToggleButton({ label, value, onToggle }) {
  return (
    <Button
      pressed={value}
      onClick={onToggle}
      size="small"
      variant={value ? "primary" : "secondary"}
      accessibilityLabel={`${label} ${value ? "enabled" : "disabled"}`}
    >
      {value ? "✓ " : ""}
      {label}
    </Button>
  );
}

export function PreviewControls({
  kwInput,
  setKwInput,
  showDraft,
  setShowDraft,
  showBefore,
  setShowBefore,
  showLoading,
  setShowLoading,
}) {
  const handleKwChange = useCallback(
    (value) => {
      // Keep input bounded to avoid preview lockups.
      const safe = typeof value === "string" ? value.slice(0, 2000) : "";
      setKwInput(safe);
    },
    [setKwInput],
  );

  return (
    <Card>
      <BlockStack gap="400">
        <TextField
          label="Seed Keywords (comma-separated)"
          value={kwInput}
          onChange={handleKwChange}
          autoComplete="off"
          placeholder="organic cotton, sustainable, ..."
          helpText="Preview-only. Production keywords must come from server-owned settings."
        />

        <InlineStack gap="300" wrap blockAlign="center">
          <ToggleButton label="Show Draft" value={showDraft} onToggle={() => setShowDraft(!showDraft)} />
          <ToggleButton label="Show Before" value={showBefore} onToggle={() => setShowBefore(!showBefore)} />
          <ToggleButton
            label="Simulate Loading"
            value={showLoading}
            onToggle={() => setShowLoading(!showLoading)}
          />

          {/* Optional semantic checkboxes for clarity (kept simple) */}
          <Checkbox
            label="Draft Visible"
            checked={showDraft}
            onChange={setShowDraft}
          />
          <Checkbox
            label="Before Visible"
            checked={showBefore}
            onChange={setShowBefore}
          />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
