// FILE: app/components/BulkComponents/PreviewModal.tsx
import React from "react";
import { Modal, BlockStack, InlineStack, Text, Badge, Banner, Card, Tag, Spinner } from "@shopify/polaris";
import type { BulkJobItem } from "../../lib/bulkJob.server";

function numericProductId(gid: string) {
  return gid.split("/").pop() ?? gid;
}

interface PreviewModalProps {
  job: BulkJobItem | null;
  isLoading: boolean;
  open: boolean;
  onClose: () => void;
  onApply: (jobId: string) => void;
  isApplying: boolean;
  applySuccess: boolean;
  applyError: string | null;
  shopDomain: string;
  /** False inside the generate modal — navigating to the full editor mid-flow breaks the in-modal review pattern. */
  showOpenEditorAction?: boolean;
}

export function PreviewModal({
  job,
  isLoading,
  open,
  onClose,
  onApply,
  isApplying,
  applySuccess,
  applyError,
  shopDomain,
  showOpenEditorAction = true,
}: PreviewModalProps) {
  if (!open) return null;

  if (isLoading || !job) {
    return (
      <Modal open={open} onClose={onClose} title="Loading preview…">
        <Modal.Section>
          <InlineStack gap="300" blockAlign="center">
            <Spinner size="small" />
            <Text as="p">Loading generated content…</Text>
          </InlineStack>
        </Modal.Section>
      </Modal>
    );
  }

  const isApplied = job.appliedAt !== null || applySuccess;
  const canApply = job.status === "COMPLETED" && !isApplied && !isApplying;

  const secondaryActions = [
    ...(showOpenEditorAction
      ? [{ content: "Open product editor", url: `/app/products/${numericProductId(job.productId)}` }]
      : []),
    { content: "Close", onAction: onClose },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">{job.productTitle}</Text>
          {isApplied && <Badge tone="success">Applied</Badge>}
        </InlineStack>
      }
      primaryAction={
        canApply
          ? { content: isApplying ? "Applying…" : "Apply to Shopify", onAction: () => onApply(job.id), loading: isApplying, disabled: isApplying }
          : undefined
      }
      secondaryActions={secondaryActions}
      large
    >
      <Modal.Section>
        <BlockStack gap="400">
          {applyError && <Banner tone="critical" title="Apply failed">{applyError}</Banner>}
          {applySuccess && <Banner tone="success" title="Applied to Shopify">This description is now live on the product.</Banner>}
          {isApplied && !applySuccess && <Banner tone="info" title="Already applied">This description was previously applied to Shopify.</Banner>}

          {(job.metaTitle || job.metaDescription) && (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">SEO Preview</Text>
                <div style={{ padding: 16, background: "#fff", border: "1px solid #dadce0", borderRadius: 8, fontFamily: "arial, sans-serif", maxWidth: 600 }}>
                  <div style={{ fontSize: 18, color: "#1a0dab", marginBottom: 4, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {job.metaTitle || job.productTitle}
                  </div>
                  <div style={{ fontSize: 13, color: "#006621", marginBottom: 4 }}>{shopDomain} › products</div>
                  <div style={{ fontSize: 14, color: "#545454", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {job.metaDescription}
                  </div>
                </div>
                {job.keywords.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {job.keywords.slice(0, 20).map((kw) => <Badge key={kw} tone="info">{kw}</Badge>)}
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          )}

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Generated Description</Text>
              {job.bodyHtml ? (
                <div
                  style={{ border: "1px solid #e1e3e5", borderRadius: 8, padding: "16px 20px", background: "#fafbfb", fontSize: 14, lineHeight: 1.6, color: "#202223", maxHeight: 400, overflowY: "auto" }}
                  dangerouslySetInnerHTML={{ __html: job.bodyHtml }}
                />
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">No description generated.</Text>
              )}
            </BlockStack>
          </Card>

          <InlineStack gap="200" wrap>
            {job.vibe && <Tag>Style: {job.vibe}</Tag>}
            {job.format && <Tag>Format: {job.format}</Tag>}
          </InlineStack>

          {job.socialCaption && (
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">Instagram caption:</Text>
                <Text as="p" variant="bodySm">{job.socialCaption}</Text>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}