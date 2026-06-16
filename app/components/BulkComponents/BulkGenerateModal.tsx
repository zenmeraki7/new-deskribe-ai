// FILE: app/components/BulkComponents/BulkGenerateModal.tsx

import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Banner,
  BlockStack,
  InlineStack,
  Modal,
  Text,
  Badge,
} from "@shopify/polaris";
import { useFetcher, useNavigate } from "@remix-run/react";
import { CREDIT_COSTS, hasCredits } from "../../lib/credits";
import { MAX_BULK_PRODUCT_COUNT } from "../../lib/bulkLimits";
import { formatCredits } from "../../utils/formatCredits";
import {
  HUGE_BULK_THRESHOLD,
  LARGE_BULK_THRESHOLD,
  MAX_KEYWORDS,
  MAX_KEYWORDS_INPUT_CHARS,
  MAX_SUGGESTED_KEYWORDS,
  type BulkKeywordResult,
  type BulkResult,
  type Format,
  type Vibe,
} from "./bulkGenerateModal.types";
import {
  clampText,
  createIdempotencyKey,
  formatDuration,
  isValidFormat,
  isValidVibe,
  normalizeKeyword,
  parseKeywords,
} from "./bulkGenerateModal.utils";
import { BulkCostCard } from "./BulkCostCard";
import { BulkKeywordSection } from "./BulkKeywordSection";
import { BulkSettingsSection } from "./BulkSettingsSection";
import { BulkStatusBanner } from "./BulkStatusBanner";

const PREF_STORAGE_KEY = "bulk-generate-preferences-v2";

interface StoredPreferences {
  vibe?: Vibe;
  format?: Format;
  keywordsInput?: string;
}

interface BulkGenerateModalProps {
  open: boolean;
  selectedProductIds: string[];
  onClose: () => void;
  onSuccess: (jobIds: string[], bulkId: string | null) => void;
  onError?: (error: {
    code: string;
    message: string;
    productCount: number;
  }) => void;
  onCreditBalanceChange: (creditsRemaining: number) => void;
  creditsRemaining: number;
  monthlyCreditLimit: number;
  monthlyCreditsUsed: number;
  maxProductCount?: number;
}

function readPreferences(): StoredPreferences {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPreferences;

    return {
      vibe: parsed.vibe && isValidVibe(parsed.vibe) ? parsed.vibe : undefined,
      format:
        parsed.format && isValidFormat(parsed.format)
          ? parsed.format
          : undefined,
      keywordsInput:
        typeof parsed.keywordsInput === "string"
          ? clampText(parsed.keywordsInput, MAX_KEYWORDS_INPUT_CHARS)
          : undefined,
    };
  } catch {
    return {};
  }
}

function writePreferences(preferences: Required<StoredPreferences>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preference persistence is optional.
  }
}

function safeNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function LiveRegion({
  isSubmitting,
  isSuggestingKeywords,
}: {
  isSubmitting: boolean;
  isSuggestingKeywords: boolean;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0,0,0,0)",
        whiteSpace: "nowrap",
      }}
    >
      {isSubmitting
        ? "Bulk generation request is being queued."
        : isSuggestingKeywords
          ? "Keyword suggestions are loading."
          : ""}
    </div>
  );
}

export function BulkGenerateModal({
  open,
  selectedProductIds,
  onClose,
  onSuccess,
  onError,
  onCreditBalanceChange,
  creditsRemaining,
  monthlyCreditLimit,
  monthlyCreditsUsed,
  maxProductCount = MAX_BULK_PRODUCT_COUNT,
}: BulkGenerateModalProps) {
  const fetcher = useFetcher<BulkResult>({ key: "bulk-generate-modal" });
  const keywordFetcher = useFetcher<BulkKeywordResult>({
    key: "bulk-keyword-suggestions-modal",
  });
  const navigate = useNavigate();

  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [vibe, setVibe] = useState<Vibe>("casual");
  const [format, setFormat] = useState<Format>("paragraph");
  const [keywordsInput, setKeywordsInput] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [suggestedSubmitted, setSuggestedSubmitted] = useState(false);
  const [suggestionCreditWarning, setSuggestionCreditWarning] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [optimisticBalance, setOptimisticBalance] = useState<number | null>(
    null,
  );
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [keywordIdempotencyKey, setKeywordIdempotencyKey] =
    useState(createIdempotencyKey);

  const lastResultRef = useRef<BulkResult | undefined>(undefined);
  const lastSuccessKeyRef = useRef<string | null>(null);
  const lastErrorKeyRef = useRef<string | null>(null);
  const lastKeywordSubmitKeyRef = useRef<string | null>(null);
  const lastAppliedCreditVersionRef = useRef<number | null>(null);

  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  const onCreditBalanceChangeRef = useRef(onCreditBalanceChange);

  const isSubmitting = fetcher.state !== "idle";
  const isSuggestingKeywords = keywordFetcher.state !== "idle";

  const count = selectedProductIds.length;
  const exceedsProductLimit = count > maxProductCount;
  const requiresLargeBulkConfirmation = count >= LARGE_BULK_THRESHOLD;
  const isHugeBulk = count >= HUGE_BULK_THRESHOLD;

  const deferredKeywordsInput = useDeferredValue(keywordsInput);
  const keywordParseResult = useMemo(
    () => parseKeywords(deferredKeywordsInput),
    [deferredKeywordsInput],
  );

  const normalizedKeywords = keywordParseResult.accepted;

  const safeCreditsRemaining = Math.max(0, safeNumber(creditsRemaining));
  const safeMonthlyCreditLimit = Math.max(0, safeNumber(monthlyCreditLimit));
  const safeMonthlyCreditsUsed = Math.max(0, safeNumber(monthlyCreditsUsed));
  const creditCost = Math.max(
    0,
    safeNumber(count * CREDIT_COSTS.bulkProductGeneration),
  );
  const projectedBalance = safeCreditsRemaining - creditCost;
  const projectedMonthlyCreditsUsed = safeMonthlyCreditsUsed + creditCost;
  const monthlyUsagePercent =
    safeMonthlyCreditLimit > 0
      ? Math.round((creditCost / safeMonthlyCreditLimit) * 100)
      : null;

  const canGenerateWithCredits = hasCredits(safeCreditsRemaining, creditCost);
  const canSuggestWithCredits = hasCredits(
    safeCreditsRemaining,
    CREDIT_COSTS.keywordSuggestion,
  );

  useEffect(() => {
    if (!preferencesLoaded) return;
    writePreferences({ vibe, format, keywordsInput });
  }, [format, keywordsInput, preferencesLoaded, vibe]);

  useEffect(() => {
    if (!open || preferencesLoaded) return;

    const preferences = readPreferences();
    if (preferences.vibe) setVibe(preferences.vibe);
    if (preferences.format) setFormat(preferences.format);
    if (preferences.keywordsInput) {
      setKeywordsInput(preferences.keywordsInput);
    }
    setPreferencesLoaded(true);
  }, [open, preferencesLoaded]);

  useEffect(() => {
    if (fetcher.data !== undefined) {
      lastResultRef.current = fetcher.data;
    }
  }, [fetcher.data]);

  const visibleResult = submitted ? lastResultRef.current : undefined;

  const visibleKeywordResult =
    suggestedSubmitted && keywordFetcher.state === "idle"
      ? keywordFetcher.data
      : undefined;

  const successfulJobIds = useMemo(
    () =>
      visibleResult?.ok && Array.isArray(visibleResult.jobIds)
        ? visibleResult.jobIds
        : [],
    [visibleResult],
  );

  const suggestedKeywords = useMemo(() => {
    if (
      !visibleKeywordResult?.ok ||
      !Array.isArray(visibleKeywordResult.keywords)
    ) {
      return [];
    }

    const seen = new Set<string>();

    return visibleKeywordResult.keywords
      .map(normalizeKeyword)
      .filter(Boolean)
      .filter((keyword) => {
        const key = keyword.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_SUGGESTED_KEYWORDS);
  }, [visibleKeywordResult]);

  const displayedBalance =
    optimisticBalance ??
    (visibleResult?.ok && typeof visibleResult.newBalance === "number"
      ? visibleResult.newBalance
      : safeCreditsRemaining);

  const estimatedCompletion = formatDuration(
    visibleResult?.estimatedCompletionSeconds,
  );

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onCreditBalanceChangeRef.current = onCreditBalanceChange;
  }, [onCreditBalanceChange]);

  useEffect(() => {
    if (!open) {
      setConfirmationOpen(false);
      return;
    }

    setSubmitted(false);
    setSuggestedSubmitted(false);
    setSuggestionCreditWarning(false);
    setOptimisticBalance(null);
    setIdempotencyKey(createIdempotencyKey());
    setKeywordIdempotencyKey(createIdempotencyKey());
    lastResultRef.current = undefined;
    lastSuccessKeyRef.current = null;
    lastErrorKeyRef.current = null;
    lastKeywordSubmitKeyRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!visibleResult?.ok || successfulJobIds.length === 0) return;

    const successKey = `${visibleResult.bulkId ?? "no-bulk"}:${successfulJobIds.join("|")}`;

    if (lastSuccessKeyRef.current === successKey) return;

    lastSuccessKeyRef.current = successKey;
    onSuccessRef.current(successfulJobIds, visibleResult.bulkId ?? null);
    setOptimisticBalance(null);
    setIdempotencyKey(createIdempotencyKey());
  }, [successfulJobIds, visibleResult]);

  useEffect(() => {
    if (!visibleResult || visibleResult.ok) return;

    setOptimisticBalance(null);

    const code = visibleResult.code ?? "UNKNOWN";
    const message =
      visibleResult.error ?? "An unexpected bulk generation error occurred.";
    const errorKey = `${idempotencyKey}:${code}:${message}`;

    if (lastErrorKeyRef.current === errorKey) return;

    lastErrorKeyRef.current = errorKey;
    onErrorRef.current?.({
      code,
      message,
      productCount: count,
    });
  }, [count, idempotencyKey, visibleResult]);

  useEffect(() => {
    const candidates = [visibleResult, visibleKeywordResult]
      .map((result) => {
        const balance = result?.newBalance ?? result?.creditsRemaining;
        const version = result?.creditBalanceVersion;

        if (typeof balance !== "number" || !Number.isFinite(balance)) {
          return null;
        }

        return {
          balance,
          version: typeof version === "number" ? version : null,
        };
      })
      .filter(Boolean) as Array<{ balance: number; version: number | null }>;

    for (const candidate of candidates) {
      if (candidate.version !== null) {
        const lastVersion = lastAppliedCreditVersionRef.current;
        if (lastVersion !== null && candidate.version <= lastVersion) continue;
        lastAppliedCreditVersionRef.current = candidate.version;
      }

      setOptimisticBalance(null);
      onCreditBalanceChangeRef.current(candidate.balance);
    }
  }, [visibleKeywordResult, visibleResult]);

  useEffect(() => {
    if (visibleKeywordResult?.ok) {
      setKeywordIdempotencyKey(createIdempotencyKey());
      lastKeywordSubmitKeyRef.current = null;
    }
  }, [visibleKeywordResult]);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    setConfirmationOpen(false);
    onClose();
  }, [isSubmitting, onClose]);

  const handleVibeChange = useCallback((value: string) => {
    if (isValidVibe(value)) setVibe(value);
  }, []);

  const handleFormatChange = useCallback((value: string) => {
    if (isValidFormat(value)) setFormat(value);
  }, []);

  const handleKeywordsChange = useCallback((value: string) => {
    setKeywordsInput(clampText(value, MAX_KEYWORDS_INPUT_CHARS));
  }, []);

  const submitBulkGeneration = useCallback(() => {
    if (count === 0) return;
    if (isSubmitting) return;
    if (exceedsProductLimit) return;
    if (!canGenerateWithCredits) return;

    setSubmitted(true);
    setConfirmationOpen(false);
    setOptimisticBalance(Math.max(0, safeCreditsRemaining - creditCost));

    fetcher.submit(
      {
        productIds: selectedProductIds,
        vibe,
        format,
        keywords: normalizedKeywords,
        idempotencyKey,
      },
      {
        method: "post",
        action: "/app/bulk-generate",
        encType: "application/json",
      },
    );
  }, [
    canGenerateWithCredits,
    count,
    creditCost,
    exceedsProductLimit,
    fetcher,
    format,
    idempotencyKey,
    isSubmitting,
    normalizedKeywords,
    safeCreditsRemaining,
    selectedProductIds,
    vibe,
  ]);

  const handlePrimaryAction = useCallback(() => {
    if (count === 0 || exceedsProductLimit || !canGenerateWithCredits) return;

    if (requiresLargeBulkConfirmation) {
      setConfirmationOpen(true);
      return;
    }

    submitBulkGeneration();
  }, [
    canGenerateWithCredits,
    count,
    exceedsProductLimit,
    requiresLargeBulkConfirmation,
    submitBulkGeneration,
  ]);

  const handleSuggestKeywords = useCallback(() => {
    if (count === 0) return;
    if (isSubmitting || isSuggestingKeywords) return;
    if (exceedsProductLimit) return;

    if (!canSuggestWithCredits) {
      setSuggestionCreditWarning(true);
      return;
    }

    if (lastKeywordSubmitKeyRef.current === keywordIdempotencyKey) return;

    lastKeywordSubmitKeyRef.current = keywordIdempotencyKey;
    setSuggestionCreditWarning(false);
    setSuggestedSubmitted(true);
    setOptimisticBalance(
      Math.max(0, safeCreditsRemaining - CREDIT_COSTS.keywordSuggestion),
    );

    keywordFetcher.submit(
      {
        productIds: selectedProductIds,
        idempotencyKey: keywordIdempotencyKey,
      },
      {
        method: "post",
        action: "/app/keywords/suggest",
        encType: "application/json",
      },
    );
  }, [
    canSuggestWithCredits,
    count,
    exceedsProductLimit,
    isSubmitting,
    isSuggestingKeywords,
    keywordFetcher,
    keywordIdempotencyKey,
    safeCreditsRemaining,
    selectedProductIds,
  ]);

  const handleAddSuggestedKeyword = useCallback((keyword: string) => {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) return;

    setKeywordsInput((previous) => {
      const existing = parseKeywords(previous).accepted;
      const exists = existing.some(
        (item) => item.toLowerCase() === normalized.toLowerCase(),
      );

      if (exists || existing.length >= MAX_KEYWORDS) return previous;

      return [...existing, normalized].join(", ");
    });
  }, []);

  const removeKeyword = useCallback((keyword: string) => {
    setKeywordsInput((previous) =>
      parseKeywords(previous)
        .accepted.filter((item) => item.toLowerCase() !== keyword.toLowerCase())
        .join(", "),
    );
  }, []);

  const navigateToResult = useCallback(
    (bulkId?: string | null) => {
      handleClose();
      navigate(bulkId ? `/app/bulk/${bulkId}` : "/app/jobs");
    },
    [handleClose, navigate],
  );

  const primaryActionContent = isSubmitting
    ? "Queuing..."
    : requiresLargeBulkConfirmation
      ? `Review generation for ${count} products`
      : `Generate for ${count} product${count !== 1 ? "s" : ""}`;

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title="Bulk generate AI descriptions"
        primaryAction={{
          content: primaryActionContent,
          onAction: handlePrimaryAction,
          loading: isSubmitting,
          disabled:
            isSubmitting ||
            count === 0 ||
            !canGenerateWithCredits ||
            exceedsProductLimit,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: handleClose,
            disabled: isSubmitting,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <LiveRegion
              isSubmitting={isSubmitting}
              isSuggestingKeywords={isSuggestingKeywords}
            />

            <InlineStack gap="200" blockAlign="center">
              <Badge
                tone={exceedsProductLimit || isHugeBulk ? "warning" : "info"}
              >
                {`${count} product${count !== 1 ? "s" : ""}`}
              </Badge>
              <Text as="span" variant="bodySm" tone="subdued">
                Maximum {maxProductCount} products per request
              </Text>
            </InlineStack>

            <BulkStatusBanner
              visibleResult={visibleResult}
              creditCost={creditCost}
              creditsRemaining={safeCreditsRemaining}
              estimatedCompletion={estimatedCompletion}
              onNavigate={navigateToResult}
            />

            {exceedsProductLimit && (
              <Banner tone="critical" title="Too many products selected">
                Select no more than {maxProductCount} products for one bulk
                generation request.
              </Banner>
            )}

            <BulkCostCard
              creditCost={creditCost}
              displayedBalance={displayedBalance}
              monthlyCreditLimit={safeMonthlyCreditLimit}
              monthlyCreditsUsed={safeMonthlyCreditsUsed}
              projectedBalance={projectedBalance}
              projectedMonthlyCreditsUsed={projectedMonthlyCreditsUsed}
              monthlyUsagePercent={monthlyUsagePercent}
              canGenerateWithCredits={canGenerateWithCredits}
            />

            <BulkKeywordSection
              keywordsInput={keywordsInput}
              normalizedKeywords={normalizedKeywords}
              keywordParseResult={keywordParseResult}
              suggestedKeywords={suggestedKeywords}
              isSubmitting={isSubmitting}
              isSuggestingKeywords={isSuggestingKeywords}
              count={count}
              exceedsProductLimit={exceedsProductLimit}
              suggestionCreditWarning={suggestionCreditWarning}
              visibleKeywordResult={visibleKeywordResult}
              onKeywordsChange={handleKeywordsChange}
              onSuggest={handleSuggestKeywords}
              onAddSuggestedKeyword={handleAddSuggestedKeyword}
              onRemoveKeyword={removeKeyword}
            />

            <BulkSettingsSection
              vibe={vibe}
              format={format}
              isSubmitting={isSubmitting}
              normalizedKeywords={normalizedKeywords}
              onVibeChange={handleVibeChange}
              onFormatChange={handleFormatChange}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={confirmationOpen}
        onClose={() => {
          if (!isSubmitting) setConfirmationOpen(false);
        }}
        title="Confirm bulk generation"
        primaryAction={{
          content: "Generate drafts",
          onAction: submitBulkGeneration,
          loading: isSubmitting,
          disabled: isSubmitting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setConfirmationOpen(false),
            disabled: isSubmitting,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Banner
              tone={isHugeBulk ? "critical" : "warning"}
              title={
                isHugeBulk
                  ? "Very large generation selected"
                  : "Large generation selected"
              }
            >
              <Text as="p" variant="bodySm">
                You are about to generate drafts for {count} products using{" "}
                {formatCredits(creditCost)} credits.
              </Text>
            </Banner>

            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                Style: {vibe}
              </Text>
              <Text as="p" variant="bodySm">
                Format: {format}
              </Text>
              <Text as="p" variant="bodySm">
                Keywords: {normalizedKeywords.length}
              </Text>
            </BlockStack>

            <Text as="p" variant="bodySm" tone="subdued">
              Generated content will be saved as drafts. You will review and
              approve changes before publishing to Shopify.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}
