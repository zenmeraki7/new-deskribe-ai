// FILE: app/components/BulkComponents/JobCard.tsx
import React from "react";
import { Badge, Button, InlineStack, BlockStack, Text, Spinner, Box } from "@shopify/polaris";

function statusBadge(status: string): { label: string; tone: "success" | "attention" | "critical" | "info" | "warning" | undefined } {
  switch (status) {
    case "COMPLETED": return { label: "Completed", tone: "success" };
    case "PENDING":   return { label: "Pending",   tone: "attention" };
    case "PROCESSING":return { label: "Processing",tone: "info" };
    case "FAILED":    return { label: "Failed",    tone: "critical" };
    case "CANCELLED": return { label: "Cancelled", tone: "warning" };
    default:          return { label: status,      tone: undefined };
  }
}

function numericProductId(gid: string) {
  return gid.split("/").pop() ?? gid;
}

export interface JobCardData {
  id: string;
  productId: string;
  productTitle: string;
  status: string;
  errorMessage: string | null;
  appliedAt: string | null;
  /** Optional — only present when the caller already has full job detail (e.g. the full History page). Compact modal polling won't have this. */
  bodyHtml?: string;
}

export interface JobCardProps {
  job: JobCardData;
  onPreview: (jobId: string) => void;
  onApplyOne: (jobId: string) => void;
  onRetryOne?: (jobId: string) => void;
  isApplying: boolean;
  isRetrying?: boolean;
  applySucceeded: boolean;
  /** Hide when rendered inside the generate modal — navigating away mid-flow doesn't make sense there. */
  showFullEditorLink?: boolean;
}

export function JobCard({
  job,
  onPreview,
  onApplyOne,
  onRetryOne,
  isApplying,
  isRetrying,
  applySucceeded,
  showFullEditorLink = true,
}: JobCardProps) {
  const { label, tone } = statusBadge(job.status);
  const isApplied = job.appliedAt !== null || applySucceeded;
  const isCompleted = job.status === "COMPLETED";
  const isFailed = job.status === "FAILED";
  const isInFlight = job.status === "PENDING" || job.status === "PROCESSING";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: 10,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <InlineStack align="space-between" blockAlign="start" wrap={false}>
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {job.productTitle}
          </Text>
          <InlineStack gap="150" blockAlign="center">
            <Badge tone={tone}>{label}</Badge>
            {isApplied && <Badge tone="success">✓ Applied</Badge>}
            {isInFlight && <Spinner size="small" />}
          </InlineStack>
        </BlockStack>
      </InlineStack>

      {isCompleted && job.bodyHtml && (
        <div
          style={{
            fontSize: 13,
            color: "#6d7175",
            lineHeight: 1.5,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
          } as any}
          dangerouslySetInnerHTML={{ __html: job.bodyHtml }}
        />
      )}

      {isFailed && job.errorMessage && (
        <Box padding="200" background="bg-surface-critical-subdued" borderRadius="200">
          <Text as="p" variant="bodySm" tone="critical">
            {job.errorMessage.length > 120 ? `${job.errorMessage.slice(0, 120)}…` : job.errorMessage}
          </Text>
        </Box>
      )}

      {isInFlight && (
        <Text as="p" variant="bodySm" tone="subdued">
          Generating description…
        </Text>
      )}

      <InlineStack gap="200" wrap>
        {isCompleted && (
          <Button size="slim" onClick={() => onPreview(job.id)}>
            Preview
          </Button>
        )}
        {isCompleted && !isApplied && (
          <Button size="slim" variant="primary" onClick={() => onApplyOne(job.id)} loading={isApplying} disabled={isApplying}>
            Apply to Shopify
          </Button>
        )}
        {isFailed && onRetryOne && (
          <Button size="slim" onClick={() => onRetryOne(job.id)} loading={isRetrying} disabled={isRetrying}>
            Retry
          </Button>
        )}
        {isCompleted && showFullEditorLink && (
          <Button size="slim" variant="plain" url={`/app/products/${numericProductId(job.productId)}`}>
            Full editor ↗
          </Button>
        )}
      </InlineStack>
    </div>
  );
}