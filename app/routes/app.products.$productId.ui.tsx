// FILE: app/routes/app.products.$productId.ui.tsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Modal,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Select,
  TextField,
  Button,
  Badge,
  Spinner,
  Checkbox,
  InlineGrid,
  Tooltip,
} from "@shopify/polaris";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";

import type { LoaderData, DraftResult, CustomTemplate } from "./app.products.$productId.types";
import {
  JOB_POLL_INTERVAL_MS,
  JOB_POLL_JITTER_RATIO,
  KEYWORDS,
  UUID_V4_RE,
} from "./app.products.$productId.constants";

import { DiffViewer } from "../components/DiffViewer";
import { CreditUsageCard } from "../components/CreditUsageCard";
import { CREDIT_COSTS, formatCredits, hasCredits } from "../lib/credits";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isUuidV4(jobId: string) {
  return UUID_V4_RE.test(jobId);
}

function parseKeywords(input: string): string[] {
  const raw = String(input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  let total = 0;

  for (const kw0 of raw) {
    const kw = kw0.slice(0, KEYWORDS.MAX_EACH_CHARS);
    if (!kw) continue;

    const lower = kw.toLowerCase();
    if (out.some((x) => x.toLowerCase() === lower)) continue;

    total += kw.length;
    if (out.length >= KEYWORDS.MAX) break;
    if (total > KEYWORDS.MAX_TOTAL_CHARS) break;

    out.push(kw);
  }

  return out;
}

function clampTextInput(value: string, maxChars: number) {
  const s = typeof value === "string" ? value : "";
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling hook
// ─────────────────────────────────────────────────────────────────────────────

type PollStatus =
  | "IDLE"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface PollPayload {
  status: PollStatus;
  result: DraftResult | null;
  errorMessage: string | null;
}

function useJobPoll() {
  const fetcher = useFetcher<PollPayload>();
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<PollStatus>("IDLE");
  const [result, setResult] = useState<DraftResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastCompletedJobId, setLastCompletedJobId] = useState<string | null>(null);

  const terminal = useMemo(
    () => new Set<PollStatus>(["COMPLETED", "FAILED", "CANCELLED"]),
    [],
  );

  const stop = useCallback(() => {
    setJobId(null);
    startedAtRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleMs = useCallback(() => {
    const base = JOB_POLL_INTERVAL_MS;
    const jitter = base * JOB_POLL_JITTER_RATIO;
    return Math.max(750, Math.floor(base + (Math.random() * 2 - 1) * jitter));
  }, []);

  useEffect(() => {
    clearTimer();
    if (!jobId) return;

    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (startedAtRef.current && Date.now() - startedAtRef.current > 5 * 60 * 1000) {
        setStatus("FAILED");
        setErrorMessage(
          "Generation did not finish. Make sure the generation worker is running and try again.",
        );
        stop();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        timerRef.current = window.setTimeout(tick, scheduleMs());
        return;
      }
      fetcher.load(`/app/api/job/${jobId}`);
      timerRef.current = window.setTimeout(tick, scheduleMs());
    };

    tick();

    return () => {
      stopped = true;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, clearTimer, scheduleMs]);

  useEffect(() => {
    if (!fetcher.data) return;

    const nextStatus: PollStatus = fetcher.data.status ?? "IDLE";
    setStatus(nextStatus);
    setErrorMessage(fetcher.data.errorMessage ?? null);

    if (fetcher.data.result) setResult(fetcher.data.result);

    if (terminal.has(nextStatus)) {
      if (nextStatus === "COMPLETED" && jobId) setLastCompletedJobId(jobId);
      stop();
    }
  }, [fetcher.data, stop, terminal, jobId]);

  const startPolling = useCallback((id: string) => {
    if (!isUuidV4(id)) return;
    setResult(null);
    setErrorMessage(null);
    setStatus("PENDING");
    startedAtRef.current = Date.now();
    setJobId(id);
  }, []);

  return {
    startPolling,
    status,
    result,
    errorMessage,
    jobId,
    lastCompletedJobId,
    isPolling: status !== "IDLE" && !terminal.has(status),
    stop,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Builder Modal
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateBuilderProps {
  open: boolean;
  onClose: () => void;
  existingTemplates: CustomTemplate[];
  isSaving: boolean;
  saveError: string;
  onSave: (name: string, instruction: string) => void;
  onSaveAndGenerate: (name: string, instruction: string) => void;
  onDelete: (id: string) => void;
}

const HINT_CHIPS = [
  "Write formally, like a luxury fashion brand",
  "Use emojis and a fun Gen-Z tone",
  "Short punchy sentences, no fluff",
  "Focus on materials and craftsmanship",
  "Write for eco-conscious shoppers",
  "Highlight the problem this product solves",
];

function TemplateBuilderModal({
  open,
  onClose,
  existingTemplates,
  isSaving,
  saveError,
  onSave,
  onSaveAndGenerate,
  onDelete,
}: TemplateBuilderProps) {
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setInstruction("");
    }
  }, [open]);

  const handleAppendHint = (hint: string) => {
    setInstruction((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}. ${hint}` : hint;
    });
  };

  const canSave = name.trim().length > 0 && instruction.trim().length > 0 && !isSaving;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Custom Writing Style"
      primaryAction={{
        content: isSaving ? "Saving…" : "Save & Generate",
        onAction: () => canSave && onSaveAndGenerate(name.trim(), instruction.trim()),
        loading: isSaving,
        disabled: !canSave,
      }}
      secondaryActions={[
        {
          content: isSaving ? "Saving…" : "Save only",
          onAction: () => canSave && onSave(name.trim(), instruction.trim()),
          disabled: !canSave || isSaving,
        },
        { content: "Cancel", onAction: onClose },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">

          {saveError && (
            <Banner tone="critical" title="Could not save template">
              <Text as="p" variant="bodySm">{saveError}</Text>
            </Banner>
          )}

          <TextField
            label="Template name"
            value={name}
            onChange={(v) => setName(clampTextInput(v, 80))}
            placeholder='e.g. "Beach Brand Voice"'
            autoComplete="off"
            maxLength={80}
            showCharacterCount
          />

          <TextField
            label="Describe your writing style to the AI"
            value={instruction}
            onChange={(v) => setInstruction(clampTextInput(v, 1000))}
            placeholder='e.g. "Write in a fun summery tone. Use short punchy sentences. Add relevant emojis. Focus on lifestyle benefits, not technical features."'
            multiline={5}
            autoComplete="off"
            maxLength={1000}
            showCharacterCount
            helpText="Just describe what you want in plain English — the AI will follow your instructions exactly."
          />

          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">
              💡 Click to add a hint:
            </Text>
            <InlineStack gap="100" wrap>
              {HINT_CHIPS.map((hint) => (
                <button
                  key={hint}
                  onClick={() => handleAppendHint(hint)}
                  style={{
                    background: "#f1f2f3",
                    border: "1px solid #c9cccf",
                    borderRadius: 20,
                    padding: "3px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "#202223",
                  }}
                >
                  {hint}
                </button>
              ))}
            </InlineStack>
          </BlockStack>

          {existingTemplates.length > 0 && (
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Your saved templates ({existingTemplates.length}/10)
              </Text>
              {existingTemplates.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    gap: 8,
                  }}
                >
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {t.name}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.instruction.slice(0, 80)}{t.instruction.length > 80 ? "…" : ""}
                    </Text>
                  </BlockStack>
                  <Button
                    size="slim"
                    tone="critical"
                    onClick={() => onDelete(t.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </BlockStack>
          )}

        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main route UI
// ─────────────────────────────────────────────────────────────────────────────

export default function ProductEditorModalRoute() {
  const {
    product,
    activeJob,
    latestDraft,
    policyWarnings,
    shopPlan,
    credits,
    customTemplates,
  } = useLoaderData<LoaderData>();

  const navigate = useNavigate();

  // ── Core generation state ─────────────────────────────────────────────────
  const [vibe, setVibe] = useState<string>("casual");
  const [format, setFormat] = useState<string>("paragraph");
  const [keywords, setKeywords] = useState<string>("");
  const [includeSocials, setIncludeSocials] = useState<boolean>(false);
  const [localCreditError, setLocalCreditError] = useState<string>("");

  // ── Custom template state ─────────────────────────────────────────────────
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);
  const [activeCustomInstruction, setActiveCustomInstruction] = useState<string>("");

  // ── Fetchers ──────────────────────────────────────────────────────────────
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();
  const descFetcher = useFetcher<any>();
  const keywordFetcher = useFetcher<any>();
  const templateFetcher = useFetcher<any>();

  // ── Polling ───────────────────────────────────────────────────────────────
  const {
    startPolling,
    status: pollStatus,
    result: pollResult,
    errorMessage: pollErrorMessage,
    lastCompletedJobId,
    isPolling,
  } = useJobPoll();

  // ── Plan gate (derived early so vibeOptions can use it) ───────────────────
  const canUseCustomTemplates = shopPlan === "advanced" || shopPlan === "pro";

  // ── Plan-gated vibe options ───────────────────────────────────────────────
  const vibeOptions = useMemo(() => {
    const builtIn = [
      { label: "Casual", value: "casual" },
      { label: "Minimalist", value: "minimalist" },
    ];

    const paidVibes =
      shopPlan !== "free"
        ? [
            { label: "Luxury", value: "luxury" },
            { label: "Technical", value: "technical" },
            { label: "Playful", value: "playful" },
          ]
        : [];

    // ── FIXED: only show saved templates and "Create" option to advanced/pro ──
    const savedTemplates = canUseCustomTemplates
      ? customTemplates.map((t) => ({
          label: `★ ${t.name}`,
          value: `custom:${t.id}`,
        }))
      : [];

    const createCustomOption = canUseCustomTemplates
      ? [{ label: "✦ Create custom style", value: "custom_new" }]
      : [];

    return [
      ...builtIn,
      ...paidVibes,
      ...savedTemplates,
      ...createCustomOption,
    ];
  }, [shopPlan, customTemplates, canUseCustomTemplates]);

  const formatOptions = useMemo(() => {
    const all = [
      { label: "Paragraph", value: "paragraph" },
      { label: "Bullets", value: "bullets" },
      { label: "Hybrid", value: "hybrid" },
    ];
    if (shopPlan === "free") {
      return all.filter((o) => o.value === "paragraph" || o.value === "bullets");
    }
    return all;
  }, [shopPlan]);

  // ── Handle vibe selection ─────────────────────────────────────────────────
  const prevVibeRef = useRef<string>("casual");

  const handleVibeChange = useCallback(
    (value: string) => {
      if (value === "__divider__") return;

      if (value === "custom_new") {
        setShowTemplateBuilder(true);
        setTimeout(() => setVibe(prevVibeRef.current), 0);
        return;
      }

      prevVibeRef.current = value;
      setVibe(value);

      if (value.startsWith("custom:")) {
        const templateId = value.replace("custom:", "");
        const tpl = customTemplates.find((t) => t.id === templateId);
        setActiveCustomInstruction(tpl?.instruction ?? "");
      } else {
        setActiveCustomInstruction("");
      }
    },
    [customTemplates],
  );

  // ── Reset to valid defaults on free plan ──────────────────────────────────
  useEffect(() => {
    if (shopPlan === "free") {
      if (vibe !== "casual" && vibe !== "minimalist" && !vibe.startsWith("custom:")) {
        setVibe("casual");
      }
      if (format !== "paragraph" && format !== "bullets") {
        setFormat("paragraph");
      }
    }
  }, [shopPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Template save handler ─────────────────────────────────────────────────
  const pendingGenerateRef = useRef(false);

  const handleSaveTemplate = useCallback(
    (name: string, instruction: string) => {
      pendingGenerateRef.current = false;
      const fd = new FormData();
      fd.set("intent", "create_template");
      fd.set("name", name);
      fd.set("instruction", instruction);
      templateFetcher.submit(fd, { method: "post" });
    },
    [templateFetcher],
  );

  const handleSaveAndGenerateTemplate = useCallback(
    (name: string, instruction: string) => {
      pendingGenerateRef.current = true;
      const fd = new FormData();
      fd.set("intent", "create_template");
      fd.set("name", name);
      fd.set("instruction", instruction);
      templateFetcher.submit(fd, { method: "post" });
    },
    [templateFetcher],
  );

  // ── Template delete handler ───────────────────────────────────────────────
  const handleDeleteTemplate = useCallback(
    (id: string) => {
      const fd = new FormData();
      fd.set("intent", "delete_template");
      fd.set("templateId", id);
      templateFetcher.submit(fd, { method: "post" });
      if (vibe === `custom:${id}`) {
        setVibe("casual");
        setActiveCustomInstruction("");
      }
    },
    [templateFetcher, vibe],
  );

  // ── Close builder on successful save ─────────────────────────────────────
  useEffect(() => {
    if (templateFetcher.data?.ok && templateFetcher.data?.kind === "create_template") {
      setShowTemplateBuilder(false);
      const newTemplate = templateFetcher.data.template;
      const savedInstruction = newTemplate?.instruction ?? "";
      if (newTemplate?.id) {
        const newVibe = `custom:${newTemplate.id}`;
        prevVibeRef.current = newVibe;
        setVibe(newVibe);
        setActiveCustomInstruction(savedInstruction);

        if (pendingGenerateRef.current) {
          if (!hasCredits(credits.creditsRemaining, CREDIT_COSTS.standardGeneration)) {
            setLocalCreditError("Not enough credits");
            return;
          }
          pendingGenerateRef.current = false;
          const fd = new FormData();
          fd.set("intent", "generate");
          fd.set("vibe", newVibe);
          fd.set("format", format);
          fd.set("keywords", clampTextInput(keywords, 2000));
          fd.set("includeSocials", String(includeSocials));
          fd.set("customInstruction", clampTextInput(savedInstruction, 1000));
          generateFetcher.submit(fd, { method: "post" });
        }
      }
    }
  }, [templateFetcher.data, credits.creditsRemaining, format, generateFetcher, includeSocials, keywords]);

  // ── Other effects ─────────────────────────────────────────────────────────
  useEffect(() => {
    const data = generateFetcher.data;
    const jobId = data?.jobId;
    if (data?.ok && typeof jobId === "string" && isUuidV4(jobId)) {
      startPolling(jobId);
    }
  }, [generateFetcher.data?.jobId, startPolling]);

  useEffect(() => {
    if (
      activeJob &&
      (activeJob.status === "PENDING" || activeJob.status === "PROCESSING")
    ) {
      startPolling(activeJob.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoadComparison = useCallback(() => {
    if (descFetcher.state !== "idle") return;
    const fd = new FormData();
    fd.set("intent", "fetch_description");
    descFetcher.submit(fd, { method: "post" });
  }, [descFetcher]);

  const handleSuggestKeywords = useCallback(() => {
    if (keywordFetcher.state !== "idle") return;
    if (!hasCredits(credits.creditsRemaining, CREDIT_COSTS.keywordSuggestion)) {
      setLocalCreditError("Not enough credits");
      return;
    }
    setLocalCreditError("");
    const fd = new FormData();
    fd.set("intent", "suggest_keywords");
    keywordFetcher.submit(fd, { method: "post" });
  }, [keywordFetcher, credits.creditsRemaining]);

  const suggestedKeywords: string[] =
    keywordFetcher.data?.ok && Array.isArray(keywordFetcher.data?.keywords)
      ? keywordFetcher.data.keywords
      : [];

  const handleAddSuggestedKeyword = useCallback((kw: string) => {
    setKeywords((prev) => {
      const existing = prev.split(",").map((k) => k.trim()).filter(Boolean);
      if (existing.some((k) => k.toLowerCase() === kw.toLowerCase())) return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const isGenerating =
    isPolling ||
    generateFetcher.state !== "idle" ||
    pollStatus === "PENDING" ||
    pollStatus === "PROCESSING";

  const isApplying = applyFetcher.state !== "idle";

  const draftResult: DraftResult | null =
    (pollResult as DraftResult | null) ?? latestDraft?.result ?? null;

  const draftHtml =
    typeof draftResult?.body_html === "string" ? draftResult.body_html : "";
  const currentHtml =
    typeof descFetcher.data?.descriptionHtml === "string"
      ? descFetcher.data.descriptionHtml
      : "";

  const highlightKeywords = useMemo(() => parseKeywords(keywords), [keywords]);

  const generateError =
    localCreditError ||
    (generateFetcher.data?.ok === false
      ? generateFetcher.data.code === "INSUFFICIENT_CREDITS"
        ? "Not enough credits"
        : String(generateFetcher.data.error ?? "")
      : "");

  const isRateLimited =
    generateFetcher.data?.ok === false &&
    (generateFetcher.data?.code === "RATE_LIMIT_EXCEEDED" ||
      generateFetcher.data?.code === "GLOBAL_LIMIT_REACHED");

  const applyError =
    applyFetcher.data && applyFetcher.data.ok === false
      ? String(applyFetcher.data.error ?? "")
      : "";
  const applySuccess =
    applyFetcher.data?.ok === true && applyFetcher.data?.applied === true;

  const templateSaveError =
    templateFetcher.data?.ok === false
      ? String(templateFetcher.data.error ?? "Something went wrong")
      : "";

  const handleClose = () => navigate("/app/products");

  useEffect(() => {
    if (draftResult) {
      console.log("=== DRAFT RESULT ===", JSON.stringify(draftResult, null, 2));
      console.log("=== DRAFT HTML ===", draftHtml);
    }
  }, [draftResult, draftHtml]);

  const applyJobId = lastCompletedJobId ?? latestDraft?.id ?? null;

  const terminalStatuses: PollStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
  const canApply = Boolean(
    draftResult &&
      draftHtml &&
      applyJobId &&
      isUuidV4(applyJobId) &&
      !isApplying &&
      !isGenerating &&
      terminalStatuses.includes(pollStatus) &&
      pollStatus !== "PENDING" &&
      pollStatus !== "PROCESSING",
  );

  const isCustomVibeSelected = vibe.startsWith("custom:");
  const canGenerateWithCredits = hasCredits(
    credits.creditsRemaining,
    CREDIT_COSTS.standardGeneration,
  );
  const canSuggestWithCredits = hasCredits(
    credits.creditsRemaining,
    CREDIT_COSTS.keywordSuggestion,
  );

  return (
    <>
      {/* ── Template Builder Modal ── */}
      <TemplateBuilderModal
        open={showTemplateBuilder}
        onClose={() => setShowTemplateBuilder(false)}
        existingTemplates={customTemplates}
        isSaving={templateFetcher.state !== "idle"}
        saveError={templateSaveError}
        onSave={handleSaveTemplate}
        onSaveAndGenerate={handleSaveAndGenerateTemplate}
        onDelete={handleDeleteTemplate}
      />

      {/* ── Main Product Editor Modal ── */}
      <Modal
        open={!showTemplateBuilder}
        onClose={handleClose}
        title={
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="headingMd">
              {product.title}
            </Text>
            {latestDraft && <Badge tone="info">Draft exists</Badge>}
            {isGenerating && <Badge tone="attention">Generating…</Badge>}
          </InlineStack>
        }
        primaryAction={{
          content: isGenerating ? "Generating…" : "Generate Draft",
          onAction: () => {
            if (!canGenerateWithCredits) {
              setLocalCreditError("Not enough credits");
              return;
            }
            setLocalCreditError("");
            const fd = new FormData();
            fd.set("intent", "generate");
            fd.set("vibe", clampTextInput(vibe, 40));
            fd.set("format", clampTextInput(format, 40));
            fd.set("keywords", clampTextInput(keywords, 2000));
            fd.set("includeSocials", String(includeSocials));
            if (isCustomVibeSelected && activeCustomInstruction) {
              fd.set("customInstruction", clampTextInput(activeCustomInstruction, 1000));
            }
            generateFetcher.submit(fd, { method: "post" });
          },
          loading: isGenerating,
          disabled: isGenerating || !canGenerateWithCredits,
        }}
        secondaryActions={[{ content: "Close", onAction: handleClose }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <CreditUsageCard
              compact
              title="Credits remaining"
              creditsUsed={credits.creditsUsed}
              creditsLimit={credits.creditsLimit}
              creditsRemaining={credits.creditsRemaining}
            />

            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Credit cost before generation
                  </Text>
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {formatCredits(CREDIT_COSTS.standardGeneration)} credit
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Remaining credits before action
                  </Text>
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {formatCredits(credits.creditsRemaining)}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Policy warnings ── */}
            {policyWarnings.length > 0 && (
              <Banner tone="warning" title="SEO Policy Warnings">
                <ul>
                  {policyWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Banner>
            )}

            {latestDraft?.isStale && (
              <Banner tone="warning" title="Draft may be outdated">
                <Text as="p" variant="bodySm">
                  This draft was generated before the product was last updated.
                </Text>
              </Banner>
            )}

            {/* ── Generate error ── */}
            {generateError && (
              <Banner
                tone={isRateLimited ? "warning" : "critical"}
                title={isRateLimited ? "Generation unavailable" : "Generation failed"}
              >
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">{generateError}</Text>
                </BlockStack>
              </Banner>
            )}

            {pollStatus === "FAILED" && (
              <Banner tone="critical" title="Generation failed">
                {pollErrorMessage ?? "The AI job failed. Please try again."}
              </Banner>
            )}

            {pollStatus === "CANCELLED" && (
              <Banner tone="warning" title="Generation cancelled">
                The job was cancelled.
              </Banner>
            )}

            {applyError && (
              <Banner tone="critical" title="Apply failed">
                {applyError}
              </Banner>
            )}

            {applySuccess && (
              <Banner tone="success" title="Applied to Shopify">
                The draft description is now live on this product.
              </Banner>
            )}

            {/* ── Generation settings card ── */}
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Generation Settings
                </Text>

                {shopPlan === "free" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    ✦ Upgrade to Basic or higher to unlock all writing styles and formats (Luxury, Technical, Playful, Hybrid).
                  </Text>
                )}

                {(shopPlan === "free" || shopPlan === "basic") && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    ✦ Upgrade to Advanced or Pro to create custom writing style templates.
                  </Text>
                )}

                <InlineGrid columns={2} gap="300">
                  {/* Writing style select + "+" button */}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Writing style"
                        options={vibeOptions}
                        value={vibe}
                        onChange={handleVibeChange}
                        disabled={isGenerating}
                      />
                    </div>
                    <div style={{ paddingBottom: 2 }}>
                      <Tooltip
                        content={
                          canUseCustomTemplates
                            ? "Create or manage custom writing styles"
                            : "Upgrade to Advanced or Pro to create custom writing styles"
                        }
                      >
                        <Button
                          size="slim"
                          onClick={() => canUseCustomTemplates && setShowTemplateBuilder(true)}
                          disabled={isGenerating || !canUseCustomTemplates}
                        >
                          +
                        </Button>
                      </Tooltip>
                    </div>
                  </div>

                  <Select
                    label="Format"
                    options={formatOptions}
                    value={format}
                    onChange={setFormat}
                    disabled={isGenerating}
                  />
                </InlineGrid>

                {/* Show active custom instruction preview */}
                {isCustomVibeSelected && activeCustomInstruction && (
                  <div
                    style={{
                      background: "#f0f4ff",
                      border: "1px solid #c7d7fd",
                      borderRadius: 8,
                      padding: "10px 14px",
                    }}
                  >
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">
                        Custom style instructions:
                      </Text>
                      <Text as="p" variant="bodySm">
                        {activeCustomInstruction.slice(0, 150)}
                        {activeCustomInstruction.length > 150 ? "…" : ""}
                      </Text>
                    </BlockStack>
                  </div>
                )}

                {/* ── Keywords ── */}
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Keywords"
                        value={keywords}
                        onChange={(v) => setKeywords(clampTextInput(v, 2000))}
                        placeholder="e.g. organic cotton, eco-friendly t-shirt"
                        autoComplete="off"
                        disabled={isGenerating}
                        helpText="Comma-separated seed keywords for SEO targeting."
                      />
                    </div>
                    <div style={{ paddingTop: 22 }}>
                        <Button
                          onClick={handleSuggestKeywords}
                          loading={keywordFetcher.state !== "idle"}
                          disabled={isGenerating || !canSuggestWithCredits}
                          size="slim"
                        >
                          ✨ Suggest
                        </Button>
                    </div>
                  </InlineStack>

                  {parseKeywords(keywords).length > 0 && (
                    <InlineStack gap="100" wrap>
                      {parseKeywords(keywords).map((kw) => (
                        <div
                          key={kw}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            background: "#f1f2f3",
                            border: "1px solid #c9cccf",
                            borderRadius: 4,
                            padding: "2px 8px",
                            fontSize: 13,
                          }}
                        >
                          {kw}
                          <button
                            onClick={() =>
                              setKeywords(
                                parseKeywords(keywords)
                                  .filter((k) => k !== kw)
                                  .join(", "),
                              )
                            }
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "0 2px",
                              fontSize: 12,
                              color: "#6d7175",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </InlineStack>
                  )}

                  {suggestedKeywords.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Suggested — click to add:
                      </Text>
                      <InlineStack gap="100" wrap>
                        {suggestedKeywords.map((kw) => (
                          <button
                            key={kw}
                            onClick={() => handleAddSuggestedKeyword(kw)}
                            style={{
                              background: "none",
                              border: "1px solid #c9cccf",
                              borderRadius: 4,
                              padding: "2px 8px",
                              cursor: "pointer",
                              fontSize: 13,
                              color: "#202223",
                            }}
                          >
                            + {kw}
                          </button>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>

                {/* <Checkbox
                  label="Include Instagram caption"
                  checked={includeSocials}
                  onChange={setIncludeSocials}
                  disabled={isGenerating}
                /> */}
              </BlockStack>
            </Card>

            {/* ── Generating progress ── */}
            {isGenerating && (
              <Card>
                <InlineStack gap="300" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="p">
                    {pollStatus === "PROCESSING"
                      ? "Deskribe AI is generating your product description…"
                      : "Preparing to generate your product description…"}
                  </Text>
                </InlineStack>
              </Card>
            )}

            {/* ── SEO preview ── */}
            {draftResult && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">SEO Preview</Text>
                  <div
                    style={{
                      padding: 16,
                      background: "#fff",
                      border: "1px solid #dadce0",
                      borderRadius: 8,
                      fontFamily: "arial, sans-serif",
                      maxWidth: 600,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 18,
                        color: "#1a0dab",
                        marginBottom: 4,
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {draftResult.meta_title ?? product.title}
                    </div>
                    <div style={{ fontSize: 13, color: "#006621", marginBottom: 4 }}>
                      {product.vendor || "Shopify"} › products
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: "#545454",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {draftResult.meta_description ?? ""}
                    </div>
                  </div>

                  {Array.isArray(draftResult.keywords) && draftResult.keywords.length > 0 && (
                    <InlineStack gap="200" wrap>
                      {draftResult.keywords
                        .filter((kw) => typeof kw === "string" && kw.trim())
                        .slice(0, 30)
                        .map((kw) => (
                          <Badge key={kw} tone="info">
                            {kw}
                          </Badge>
                        ))}
                    </InlineStack>
                  )}

                  {draftResult.social_caption && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Instagram caption:
                      </Text>
                      <Text as="p" variant="bodySm">
                        {draftResult.social_caption}
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* ── Diff viewer ── */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">Compare</Text>
                  {!currentHtml && (
                    <Button
                      onClick={handleLoadComparison}
                      loading={descFetcher.state !== "idle"}
                      size="slim"
                    >
                      Load current description
                    </Button>
                  )}
                </InlineStack>
                <DiffViewer
                  beforeHtml={currentHtml}
                  afterHtml={draftHtml}
                  keywords={highlightKeywords}
                  isLoading={descFetcher.state !== "idle"}
                />
              </BlockStack>
            </Card>

            {/* ── Apply to Shopify ── */}
            {(latestDraft || pollStatus === "COMPLETED") && (
              <InlineStack align="end">
                <Button
                  variant="primary"
                  tone="success"
                  disabled={!canApply}
                  loading={isApplying}
                  onClick={() => {
                    if (!applyJobId || !isUuidV4(applyJobId)) return;
                    const fd = new FormData();
                    fd.set("intent", "apply");
                    fd.set("jobId", applyJobId);
                    applyFetcher.submit(fd, { method: "post" });
                  }}
                >
                  Apply to Shopify
                </Button>
              </InlineStack>
            )}

          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}
