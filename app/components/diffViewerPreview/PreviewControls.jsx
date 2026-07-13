import React, { useCallback } from "react";
import {
  Card,
  InlineStack,
  TextField,
  Checkbox,
  BlockStack,
} from "@shopify/polaris";

/**
 * PreviewControls (DEMO-ONLY)
 *
 * Security contract:
 * - Demo UI only. Must never be reused in production flows for saving/applying content.
 * - Keyword input is for preview rendering only.
 */

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
          maxLength={2000}
          placeholder="organic cotton, sustainable, ..."
          helpText="Preview-only. Production keywords must come from server-owned settings."
        />

        <InlineStack gap="300" wrap blockAlign="center">
          <Checkbox
            label="Show Draft"
            checked={showDraft}
            onChange={setShowDraft}
          />

          <Checkbox
            label="Show Before"
            checked={showBefore}
            onChange={setShowBefore}
          />

          <Checkbox
            label="Simulate Loading"
            checked={showLoading}
            onChange={setShowLoading}
          />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
