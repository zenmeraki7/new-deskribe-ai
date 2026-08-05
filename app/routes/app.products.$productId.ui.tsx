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
  InlineGrid,
  Tooltip,
  Popover,
  Checkbox,
  Box,
} from "@shopify/polaris";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "@remix-run/react";
import { useJobPoll } from "../hooks/useJobPoll";

import type {
  LoaderData,
  DraftResult,
  CustomTemplate,
} from "./app.products.$productId.types";
import { KEYWORDS, UUID_V4_RE } from "./app.products.$productId.constants";

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
// Section selector (replaces tab bar)
// ─────────────────────────────────────────────────────────────────────────────

type SectionKey = "description" | "meta" | "alttext";

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

  const canSave =
    name.trim().length > 0 && instruction.trim().length > 0 && !isSaving;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Custom Writing Style"
      primaryAction={{
        content: isSaving ? "Saving…" : "Save & Generate",
        onAction: () =>
          canSave && onSaveAndGenerate(name.trim(), instruction.trim()),
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
              <Text as="p" variant="bodySm">
                {saveError}
              </Text>
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
                      {t.instruction.slice(0, 80)}
                      {t.instruction.length > 80 ? "…" : ""}
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
  const revalidator = useRevalidator();

  // ── Core generation state ─────────────────────────────────────────────────
  const [vibe, setVibe] = useState<string>("casual");
  const [format, setFormat] = useState<string>("paragraph");
  const [keywords, setKeywords] = useState<string>("");
  const [includeSocials, setIncludeSocials] = useState<boolean>(false);
  const [localCreditError, setLocalCreditError] = useState<string>("");
  const [generationRequestPending, setGenerationRequestPending] =
    useState(false);
  const [appliedAltText, setAppliedAltText] = useState<Record<string, string>>({});
  const [isClosing, setIsClosing] = useState(false);
  const generationSubmitLockedRef = useRef(false);

  // ── Section selector state (replaces tabs) ────────────────────────────────
  const SECTION_LABELS: Record<SectionKey, string> = {
    description: "Description",
    meta: "Meta title & description",
    alttext: `Image alt text${product.images.length > 0 ? ` (${product.images.length})` : ""}`,
  };

  const [selectedSections, setSelectedSections] = useState<SectionKey[]>([
    "description",
  ]);
  // What was actually generated in the last run — gates things like the SEO Preview
  // so toggling checkboxes afterwards doesn't retroactively show/hide existing content.
  const [sectionsGenerated, setSectionsGenerated] = useState<SectionKey[]>([
    "description",
  ]);
  const [sectionPopoverActive, setSectionPopoverActive] = useState(false);

  const toggleSection = useCallback((key: SectionKey, checked: boolean) => {
    setSelectedSections((prev) => {
      if (checked) return prev.includes(key) ? prev : [...prev, key];
      return prev.filter((s) => s !== key);
    });
  }, []);

  // ── Custom template state ─────────────────────────────────────────────────
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);
  const [activeCustomInstruction, setActiveCustomInstruction] =
    useState<string>("");

  // ── Meta tab state ────────────────────────────────────────────────────────
  const [metaTitle, setMetaTitle] = useState<string>("");
  const [metaDescription, setMetaDescription] = useState<string>("");

  // ── Fetchers ──────────────────────────────────────────────────────────────
  const generateFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();
  const descFetcher = useFetcher<any>();
  const keywordFetcher = useFetcher<any>();
  const templateFetcher = useFetcher<any>();
  const metaFetcher = useFetcher<any>();
  const applyMetaFetcher = useFetcher<any>();

  const [altTextDrafts, setAltTextDrafts] = useState<Record<string, string>>(
    {},
  );
  const altTextFetcher = useFetcher<any>();
  const altTextBulkFetcher = useFetcher<any>();
  const applyAltTextFetcher = useFetcher<any>();
  const applyAltTextBulkFetcher = useFetcher<any>();

  // ── Polling ───────────────────────────────────────────────────────────────
  const {
    startPolling,
    reset: resetPolling,
    status: pollStatus,
    result: pollResult,
    errorMessage: pollErrorMessage,
    lastCompletedJobId,
    jobId: pollingJobId,
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

    const savedTemplates = canUseCustomTemplates
      ? customTemplates.map((t) => ({
          label: `★ ${t.name}`,
          value: `custom:${t.id}`,
        }))
      : [];

    const createCustomOption = canUseCustomTemplates
      ? [{ label: "✦ Create custom style", value: "custom_new" }]
      : [];

    return [...builtIn, ...paidVibes, ...savedTemplates, ...createCustomOption];
  }, [shopPlan, customTemplates, canUseCustomTemplates]);

  const formatOptions = useMemo(() => {
    const all = [
      { label: "Paragraph", value: "paragraph" },
      { label: "Bullets", value: "bullets" },
      { label: "Hybrid", value: "hybrid" },
    ];
    if (shopPlan === "free") {
      return all.filter(
        (o) => o.value === "paragraph" || o.value === "bullets",
      );
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
      if (
        vibe !== "casual" &&
        vibe !== "minimalist" &&
        !vibe.startsWith("custom:")
      ) {
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
    if (
      templateFetcher.data?.ok &&
      templateFetcher.data?.kind === "create_template"
    ) {
      setShowTemplateBuilder(false);
      const newTemplate = templateFetcher.data.template;
      const savedInstruction = newTemplate?.instruction ?? "";
      if (newTemplate?.id) {
        const newVibe = `custom:${newTemplate.id}`;
        prevVibeRef.current = newVibe;
        setVibe(newVibe);
        setActiveCustomInstruction(savedInstruction);

        if (pendingGenerateRef.current) {
          if (
            !hasCredits(
              credits.creditsRemaining,
              CREDIT_COSTS.standardGeneration,
            )
          ) {
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
          fd.set("includeMeta", String(selectedSections.includes("meta")));
          fd.set("customInstruction", clampTextInput(savedInstruction, 1000));
          setSectionsGenerated(selectedSections);
          generateFetcher.submit(fd, { method: "post" });
        }
      }
    }
  }, [
    templateFetcher.data,
    credits.creditsRemaining,
    format,
    generateFetcher,
    includeSocials,
    keywords,
    selectedSections,
  ]);

  // ── Generation effects ────────────────────────────────────────────────────
  useEffect(() => {
    const data = generateFetcher.data;
    const jobId = data?.jobId;
    if (data?.ok && typeof jobId === "string" && isUuidV4(jobId)) {
      startPolling(jobId);
    }
  }, [generateFetcher.data?.jobId, startPolling]);

  useEffect(() => {
    if (generateFetcher.state !== "idle" || !generateFetcher.data) return;
    generationSubmitLockedRef.current = false;
    setGenerationRequestPending(false);
  }, [generateFetcher.state, generateFetcher.data]);

  useEffect(() => {
    if (
      activeJob &&
      (activeJob.status === "PENDING" || activeJob.status === "PROCESSING")
    ) {
      startPolling(activeJob.id);
    }
  }, [activeJob?.id, activeJob?.status, startPolling]);

  const lastRevalidatedJobIdRef = useRef<string | null>(null);

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
      const existing = prev
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (existing.some((k) => k.toLowerCase() === kw.toLowerCase()))
        return prev;
      return [...existing, kw].join(", ");
    });
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const draftResult: DraftResult | null =
    (pollResult as DraftResult | null) ?? latestDraft?.result ?? null;

  const latestDraftCompletesActiveJob = Boolean(
    latestDraft?.id &&
    latestDraft.result &&
    (latestDraft.id === lastCompletedJobId ||
      latestDraft.id === pollingJobId ||
      latestDraft.id === activeJob?.id),
  );

  const isGenerating =
    (generationRequestPending && !latestDraftCompletesActiveJob) ||
    (isPolling && !latestDraftCompletesActiveJob) ||
    generateFetcher.state !== "idle" ||
    ((pollStatus === "PENDING" || pollStatus === "PROCESSING") &&
      !latestDraftCompletesActiveJob);

  const isApplying = applyFetcher.state !== "idle";

  useEffect(() => {
    if (!latestDraftCompletesActiveJob) return;
    generationSubmitLockedRef.current = false;
    setGenerationRequestPending(false);
    if (
      pollStatus !== "PENDING" &&
      pollStatus !== "PROCESSING" &&
      pollStatus !== "COMPLETED"
    ) {
      return;
    }
    resetPolling();
  }, [latestDraftCompletesActiveJob, pollStatus, resetPolling]);

  useEffect(() => {
    if (pollStatus !== "COMPLETED" || !lastCompletedJobId) return;
    if (lastRevalidatedJobIdRef.current === lastCompletedJobId) return;
    lastRevalidatedJobIdRef.current = lastCompletedJobId;
    revalidator.revalidate();
  }, [lastCompletedJobId, pollStatus, revalidator]);

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

  const modalSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!applySuccess) return;
    const scrollContainer = (modalSectionRef.current?.closest(
      ".Polaris-Scrollable",
    ) ??
      document.querySelector(".Polaris-Modal-Section") ??
      document.querySelector(".Polaris-Scrollable")) as HTMLElement | null;
    scrollContainer?.scrollTo({ top: 0, behavior: "smooth" });
  }, [applySuccess, applyFetcher.data]);

  const templateSaveError =
    templateFetcher.data?.ok === false
      ? String(templateFetcher.data.error ?? "Something went wrong")
      : "";

  const isGenerationBusy = isGenerating || generationSubmitLockedRef.current;

  useEffect(() => {
    if (draftResult) {
      console.log("=== DRAFT RESULT ===", JSON.stringify(draftResult, null, 2));
      console.log("=== DRAFT HTML ===", draftHtml);
    }
  }, [draftResult, draftHtml]);

  const applyJobId = lastCompletedJobId ?? latestDraft?.id ?? null;
  const hasCompletedStatus =
    pollStatus === "COMPLETED" ||
    latestDraft?.id === applyJobId ||
    latestDraftCompletesActiveJob;

  const hasCompletedDraft = Boolean(
    draftResult &&
    draftHtml &&
    applyJobId &&
    isUuidV4(applyJobId) &&
    hasCompletedStatus,
  );

  const canApply = Boolean(
    hasCompletedDraft &&
    !isApplying &&
    (!isPolling || latestDraftCompletesActiveJob) &&
    (pollStatus !== "PENDING" || latestDraftCompletesActiveJob) &&
    (pollStatus !== "PROCESSING" || latestDraftCompletesActiveJob) &&
    generateFetcher.state === "idle" &&
    (!generationRequestPending || latestDraftCompletesActiveJob),
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

  // ── Alt text handlers ─────────────────────────────────────────────────────
  const handleGenerateAltText = useCallback(
    (imageId: string, imageIndex: number, totalImages: number) => {
      if (
        !hasCredits(credits.creditsRemaining, CREDIT_COSTS.altTextGeneration)
      ) {
        setLocalCreditError("Not enough credits");
        return;
      }
      setLocalCreditError("");
      const fd = new FormData();
      fd.set("intent", "generate_alt_text");
      fd.set("imageId", imageId);
      fd.set("imageIndex", String(imageIndex));
      fd.set("totalImages", String(totalImages));
      altTextFetcher.submit(fd, { method: "post" });
    },
    [altTextFetcher, credits.creditsRemaining],
  );

  useEffect(() => {
    if (
      altTextFetcher.data?.ok &&
      altTextFetcher.data?.kind === "generate_alt_text"
    ) {
      const { imageId, altText } = altTextFetcher.data;
      setAltTextDrafts((prev) => ({ ...prev, [imageId]: altText }));
    }
  }, [altTextFetcher.data]);

  const handleGenerateAllAltText = useCallback(() => {
    const totalCost = CREDIT_COSTS.altTextGeneration * product.images.length;
    if (!hasCredits(credits.creditsRemaining, totalCost)) {
      setLocalCreditError("Not enough credits");
      return;
    }
    setLocalCreditError("");
    const fd = new FormData();
    fd.set("intent", "generate_alt_text_bulk");
    fd.set("imageIds", JSON.stringify(product.images.map((img) => img.id)));
    altTextBulkFetcher.submit(fd, { method: "post" });
  }, [altTextBulkFetcher, credits.creditsRemaining, product.images]);

  useEffect(() => {
    if (
      altTextBulkFetcher.data?.ok &&
      altTextBulkFetcher.data?.kind === "generate_alt_text_bulk"
    ) {
      const results = altTextBulkFetcher.data.results as {
        imageId: string;
        altText: string;
      }[];
      setAltTextDrafts((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.imageId] = r.altText;
        return next;
      });
    }
  }, [altTextBulkFetcher.data]);

  const handleApplyAltText = useCallback(
    (imageId: string) => {
      const altText = altTextDrafts[imageId];
      if (!altText?.trim()) return;
      const fd = new FormData();
      fd.set("intent", "apply_alt_text");
      fd.set("imageId", imageId);
      fd.set("altText", altText);
      applyAltTextFetcher.submit(fd, { method: "post" });
    },
    [altTextDrafts, applyAltTextFetcher],
  );

  const handleApplyAllAltText = useCallback(() => {
    const items = product.images
      .filter((img) => altTextDrafts[img.id]?.trim())
      .map((img) => ({ imageId: img.id, altText: altTextDrafts[img.id] }));
    if (items.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "apply_alt_text_bulk");
    fd.set("items", JSON.stringify(items));
    applyAltTextBulkFetcher.submit(fd, { method: "post" });
  }, [altTextDrafts, product.images, applyAltTextBulkFetcher]);

  useEffect(() => {
    if (applyAltTextFetcher.data?.ok) revalidator.revalidate();
  }, [applyAltTextFetcher.data, revalidator]);

  useEffect(() => {
    if (applyAltTextBulkFetcher.data?.ok) revalidator.revalidate();
  }, [applyAltTextBulkFetcher.data, revalidator]);

  // ── Meta effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (draftResult?.meta_title && !metaTitle)
      setMetaTitle(draftResult.meta_title);
    if (draftResult?.meta_description && !metaDescription)
      setMetaDescription(draftResult.meta_description);
  }, [draftResult]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (metaFetcher.data?.ok && metaFetcher.data?.kind === "generate_meta") {
      if (metaFetcher.data.meta_title)
        setMetaTitle(metaFetcher.data.meta_title);
      if (metaFetcher.data.meta_description)
        setMetaDescription(metaFetcher.data.meta_description);
    }
  }, [metaFetcher.data]);

  // ── Generate handler (single action, fans out by selected sections) ──────
  const handleGenerate = useCallback(() => {
    if (isGenerationBusy || selectedSections.length === 0) return;

    const wantsDescription = selectedSections.includes("description");
    const wantsMeta = selectedSections.includes("meta");
    const wantsAltText = selectedSections.includes("alttext");

    let totalCost = 0;
    if (wantsDescription) totalCost += CREDIT_COSTS.standardGeneration; // meta bundled in, free when combined
    if (wantsMeta && !wantsDescription)
      totalCost += CREDIT_COSTS.metaGeneration;
    if (wantsAltText)
      totalCost += CREDIT_COSTS.altTextGeneration * product.images.length;

    if (!hasCredits(credits.creditsRemaining, totalCost)) {
      setLocalCreditError("Not enough credits");
      return;
    }

    setLocalCreditError("");
    setSectionsGenerated(selectedSections);

    if (wantsDescription) {
      generationSubmitLockedRef.current = true;
      setGenerationRequestPending(true);
      const fd = new FormData();
      fd.set("intent", "generate");
      fd.set("vibe", clampTextInput(vibe, 40));
      fd.set("format", clampTextInput(format, 40));
      fd.set("keywords", clampTextInput(keywords, 2000));
      fd.set("includeSocials", String(includeSocials));
      fd.set("includeMeta", String(wantsMeta));
      if (isCustomVibeSelected && activeCustomInstruction) {
        fd.set(
          "customInstruction",
          clampTextInput(activeCustomInstruction, 1000),
        );
      }
      generateFetcher.submit(fd, { method: "post" });
    } else if (wantsMeta) {
      const fd = new FormData();
      fd.set("intent", "generate_meta");
      fd.set("keywords", keywords);
      metaFetcher.submit(fd, { method: "post" });
    }

    if (wantsAltText) {
      handleGenerateAllAltText();
    }
  }, [
    selectedSections,
    isGenerationBusy,
    credits.creditsRemaining,
    product.images.length,
    vibe,
    format,
    keywords,
    includeSocials,
    isCustomVibeSelected,
    activeCustomInstruction,
    generateFetcher,
    metaFetcher,
    handleGenerateAllAltText,
  ]);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    resetPolling();
    navigate("/app/products");
  }, [isClosing, navigate, resetPolling]);

  // ── Combined cost + busy state for the single Generate button ────────────
  const totalGenerateCost = useMemo(() => {
    let cost = 0;
    if (selectedSections.includes("description"))
      cost += CREDIT_COSTS.standardGeneration;
    if (
      selectedSections.includes("meta") &&
      !selectedSections.includes("description")
    ) {
      cost += CREDIT_COSTS.metaGeneration;
    }
    if (selectedSections.includes("alttext")) {
      cost += CREDIT_COSTS.altTextGeneration * product.images.length;
    }
    return cost;
  }, [selectedSections, product.images.length]);

  const canGenerateSelected =
    selectedSections.length > 0 &&
    hasCredits(credits.creditsRemaining, totalGenerateCost);

  const isAltTextBusy =
    altTextBulkFetcher.state !== "idle" ||
    (selectedSections.includes("alttext") && altTextFetcher.state !== "idle");

  const isAnyGenerationBusy =
    isGenerationBusy || metaFetcher.state !== "idle" || isAltTextBusy;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

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
        open={!showTemplateBuilder && !isClosing}
        onClose={handleClose}
        size="large"
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
          content: isAnyGenerationBusy
            ? "Generating…"
            : `Generate${selectedSections.length ? ` (${formatCredits(totalGenerateCost)} credits)` : ""}`,
          onAction: handleGenerate,
          loading: isAnyGenerationBusy,
          disabled: isAnyGenerationBusy || !canGenerateSelected,
        }}
        secondaryActions={[{ content: "Close", onAction: handleClose }]}
      >
        <Modal.Section>
          <div ref={modalSectionRef}>
            <BlockStack gap="400">
              {/* ── Credits ── */}
              <CreditUsageCard
                compact
                title="Credits remaining"
                creditsUsed={credits.creditsUsed}
                creditsLimit={credits.creditsLimit}
                creditsRemaining={credits.creditsRemaining}
              />

              {/* ── Section selector dropdown (replaces tab bar) ── */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    What do you want to generate?
                  </Text>

                  <Popover
                    active={sectionPopoverActive}
                    onClose={() => setSectionPopoverActive(false)}
                    fullWidth
                    activator={
                      <Button
                        disclosure
                        fullWidth
                        textAlign="left"
                        onClick={() => setSectionPopoverActive((v) => !v)}
                      >
                        {selectedSections.length
                          ? selectedSections
                              .map((s) => SECTION_LABELS[s])
                              .join(", ")
                          : "Select sections"}
                      </Button>
                    }
                  >
                    <Box padding="300">
                      <BlockStack gap="200">
                        <Checkbox
                          label={SECTION_LABELS.description}
                          checked={selectedSections.includes("description")}
                          onChange={(checked) =>
                            toggleSection("description", checked)
                          }
                        />
                        <Checkbox
                          label={SECTION_LABELS.meta}
                          checked={selectedSections.includes("meta")}
                          onChange={(checked) => toggleSection("meta", checked)}
                        />
                        <Checkbox
                          label={SECTION_LABELS.alttext}
                          checked={selectedSections.includes("alttext")}
                          onChange={(checked) =>
                            toggleSection("alttext", checked)
                          }
                          disabled={product.images.length === 0}
                        />
                      </BlockStack>
                    </Box>
                  </Popover>

                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Estimated credit cost
                    </Text>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {formatCredits(totalGenerateCost)} credit
                      {totalGenerateCost === 1 ? "" : "s"}
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

              {localCreditError && (
                <Banner tone="critical" title="Not enough credits">
                  <Text as="p" variant="bodySm">
                    {localCreditError}
                  </Text>
                </Banner>
              )}

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
                    This draft was generated before the product was last
                    updated.
                  </Text>
                </Banner>
              )}

              {generateError && (
                <Banner
                  tone={isRateLimited ? "warning" : "critical"}
                  title={
                    isRateLimited
                      ? "Generation unavailable"
                      : "Generation failed"
                  }
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm">
                      {generateError}
                    </Text>
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
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm">
                      The draft description is now live on this product.
                    </Text>
                    {(draftResult?.meta_title ||
                      draftResult?.meta_description) && (
                      <Text as="p" variant="bodySm">
                        SEO title and meta description were also updated on
                        Shopify.
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              {/* ══════════════════════════════════════════════
                  SECTION: Description
              ══════════════════════════════════════════════ */}
              {selectedSections.includes("description") && (
                <BlockStack gap="400">
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">
                        Description Settings
                      </Text>

                      {shopPlan === "free" && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          ✦ Upgrade to Basic or higher to unlock all writing
                          styles and formats (Luxury, Technical, Playful,
                          Hybrid).
                        </Text>
                      )}

                      {(shopPlan === "free" || shopPlan === "basic") && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          ✦ Upgrade to Advanced or Pro to create custom writing
                          style templates.
                        </Text>
                      )}

                      <InlineGrid columns={2} gap="300">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-end",
                            gap: 8,
                          }}
                        >
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
                                onClick={() =>
                                  canUseCustomTemplates &&
                                  setShowTemplateBuilder(true)
                                }
                                disabled={
                                  isGenerating || !canUseCustomTemplates
                                }
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
                            <Text
                              as="p"
                              variant="bodySm"
                              fontWeight="semibold"
                              tone="subdued"
                            >
                              Custom style instructions:
                            </Text>
                            <Text as="p" variant="bodySm">
                              {activeCustomInstruction.slice(0, 150)}
                              {activeCustomInstruction.length > 150 ? "…" : ""}
                            </Text>
                          </BlockStack>
                        </div>
                      )}

                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="end">
                          <div style={{ flex: 1 }}>
                            <TextField
                              label="Keywords"
                              value={keywords}
                              onChange={(v) =>
                                setKeywords(clampTextInput(v, 2000))
                              }
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
                    </BlockStack>
                  </Card>

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

                  {draftResult && (
                    <Card>
                      <BlockStack gap="200">
                        {sectionsGenerated.includes("meta") && (
                          <>
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <Text as="h3" variant="headingSm">
                                SEO Preview
                              </Text>
                              {applySuccess && (
                                <Badge tone="success">Synced to Shopify</Badge>
                              )}
                            </InlineStack>
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
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "#006621",
                                  marginBottom: 4,
                                }}
                              >
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
                          </>
                        )}

                        {Array.isArray(draftResult.keywords) &&
                          draftResult.keywords.length > 0 && (
                            <InlineStack gap="200" wrap>
                              {draftResult.keywords
                                .filter(
                                  (kw) => typeof kw === "string" && kw.trim(),
                                )
                                .slice(0, 30)
                                .map((kw) => (
                                  <Badge key={kw} tone="info">
                                    {kw}
                                  </Badge>
                                ))}
                            </InlineStack>
                          )}

                        {sectionsGenerated.includes("meta") &&
                          draftResult.social_caption && (
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

                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          Compare
                        </Text>
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

                  {hasCompletedDraft && (
                    <InlineStack align="end" gap="300" blockAlign="center">
                      {applySuccess && (
                        <Text as="p" tone="success" fontWeight="semibold">
                          Applied to Shopify ✓
                        </Text>
                      )}
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
              )}

              {/* ══════════════════════════════════════════════
                  SECTION: Meta title & description
              ══════════════════════════════════════════════ */}
              {selectedSections.includes("meta") && (
                <BlockStack gap="400">
                  {applyMetaFetcher.data?.ok === true && (
                    <Banner tone="success" title="Applied to Shopify">
                      <Text as="p" variant="bodySm">
                        Meta title and description are now live on this product.
                      </Text>
                    </Banner>
                  )}

                  {applyMetaFetcher.data?.ok === false && (
                    <Banner tone="critical" title="Apply failed">
                      {String(applyMetaFetcher.data.error ?? "")}
                    </Banner>
                  )}

                  {metaFetcher.data?.ok === false && (
                    <Banner tone="critical" title="Generation failed">
                      {String(metaFetcher.data.error ?? "")}
                    </Banner>
                  )}

                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          Meta title
                        </Text>
                        <Text
                          as="p"
                          variant="bodySm"
                          tone={metaTitle.length > 60 ? "critical" : "subdued"}
                        >
                          {metaTitle.length} / 60
                        </Text>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Controls the blue headline in Google search results.
                      </Text>
                      <TextField
                        label="Meta title"
                        labelHidden
                        value={metaTitle}
                        onChange={(v) => setMetaTitle(clampTextInput(v, 70))}
                        placeholder="e.g. Organic Cotton T-Shirt | Your Brand"
                        autoComplete="off"
                        helpText={
                          metaTitle.length > 60
                            ? "Over 60 characters — Google may truncate this."
                            : "Keep under 60 characters for Google to display in full."
                        }
                      />
                    </BlockStack>
                  </Card>

                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          Meta description
                        </Text>
                        <Text
                          as="p"
                          variant="bodySm"
                          tone={
                            metaDescription.length > 155
                              ? "critical"
                              : "subdued"
                          }
                        >
                          {metaDescription.length} / 155
                        </Text>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        The snippet shown below the title in search results.
                      </Text>
                      <TextField
                        label="Meta description"
                        labelHidden
                        value={metaDescription}
                        onChange={(v) =>
                          setMetaDescription(clampTextInput(v, 320))
                        }
                        placeholder="e.g. Shop our new arrival. Free shipping on orders over £50."
                        multiline={3}
                        autoComplete="off"
                        helpText={
                          metaDescription.length > 155
                            ? "Over 155 characters — consider trimming for best results."
                            : "Keep under 155 characters."
                        }
                      />
                    </BlockStack>
                  </Card>

                  <Text as="p" variant="bodySm" tone="subdued">
                    Use the Generate button above, or edit the fields above
                    manually.
                  </Text>

                  {(metaTitle || metaDescription) && (
                    <Card>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Live preview
                        </Text>
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
                            {metaTitle || product.title}
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              color: "#006621",
                              marginBottom: 4,
                            }}
                          >
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
                            {metaDescription || "No description yet."}
                          </div>
                        </div>
                      </BlockStack>
                    </Card>
                  )}

                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      tone="success"
                      loading={applyMetaFetcher.state !== "idle"}
                      disabled={!metaTitle.trim() && !metaDescription.trim()}
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("intent", "apply_meta");
                        fd.set("metaTitle", metaTitle);
                        fd.set("metaDescription", metaDescription);
                        applyMetaFetcher.submit(fd, { method: "post" });
                      }}
                    >
                      Apply to Shopify
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}

              {/* ══════════════════════════════════════════════
                  SECTION: Image alt text
              ══════════════════════════════════════════════ */}
              {selectedSections.includes("alttext") && (
                <BlockStack gap="400">
                  {product.images.length === 0 ? (
                    <Banner tone="info" title="No images">
                      <Text as="p" variant="bodySm">
                        This product has no images to generate alt text for.
                      </Text>
                    </Banner>
                  ) : (
                    <Card>
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingSm">
                            Image Alt Text
                          </Text>
                          <Button
                            onClick={handleGenerateAllAltText}
                            loading={altTextBulkFetcher.state !== "idle"}
                            disabled={
                              !hasCredits(
                                credits.creditsRemaining,
                                CREDIT_COSTS.altTextGeneration *
                                  product.images.length,
                              )
                            }
                            size="slim"
                          >
                            ✨ Generate all (
                            {formatCredits(
                              CREDIT_COSTS.altTextGeneration *
                                product.images.length,
                            )}{" "}
                            credits)
                          </Button>
                        </InlineStack>

                        {altTextFetcher.data?.ok === false && (
                          <Banner tone="critical" title="Generation failed">
                            {String(altTextFetcher.data.error ?? "")}
                          </Banner>
                        )}
                        {altTextBulkFetcher.data?.ok === false && (
                          <Banner
                            tone="critical"
                            title="Bulk generation failed"
                          >
                            {String(altTextBulkFetcher.data.error ?? "")}
                          </Banner>
                        )}
                        {(applyAltTextFetcher.data?.ok === false ||
                          applyAltTextBulkFetcher.data?.ok === false) && (
                          <Banner
                            tone="critical"
                            title="Failed to apply alt text"
                          >
                            {String(
                              applyAltTextFetcher.data?.error ??
                                applyAltTextBulkFetcher.data?.error ??
                                "",
                            )}
                          </Banner>
                        )}
                        {/* ADD THIS: success banner for single + bulk apply */}
                        {(applyAltTextFetcher.data?.ok === true ||
                          applyAltTextBulkFetcher.data?.ok === true) && (
                          <Banner tone="success" title="Applied to Shopify">
                            <Text as="p" variant="bodySm">
                              Alt text is now live on this product.
                            </Text>
                          </Banner>
                        )}

                        {product.images.map((img, idx) => {
                          const draft = altTextDrafts[img.id] ?? "";
                          const isGeneratingThis =
                            altTextFetcher.state !== "idle" &&
                            altTextFetcher.formData?.get("imageId") === img.id;
                          const isApplyingThis =
                            applyAltTextFetcher.state !== "idle" &&
                            applyAltTextFetcher.formData?.get("imageId") ===
                              img.id;
                          const hasDraft = draft.trim().length > 0;

                          return (
                            <InlineStack
                              key={img.id}
                              gap="300"
                              blockAlign="start"
                              wrap={false}
                            >
                              <img
                                src={img.url}
                                alt=""
                                style={{
                                  width: 64,
                                  height: 64,
                                  objectFit: "cover",
                                  borderRadius: 8,
                                  border: "1px solid #e1e3e5",
                                  flexShrink: 0,
                                }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <BlockStack gap="150">
                                  {img.altText && (
                                    <Text
                                      as="p"
                                      variant="bodySm"
                                      tone="subdued"
                                    >
                                      Current: {img.altText}
                                    </Text>
                                  )}
                                  <TextField
                                    label={`Image ${idx + 1} alt text`}
                                    labelHidden
                                    value={draft}
                                    onChange={(v) =>
                                      setAltTextDrafts((prev) => ({
                                        ...prev,
                                        [img.id]: clampTextInput(v, 200),
                                      }))
                                    }
                                    placeholder="No draft yet — click Generate"
                                    autoComplete="off"
                                    helpText={`${draft.length}/125 characters${
                                      draft.length > 125
                                        ? " (longer than recommended)"
                                        : ""
                                    }`}
                                  />
                                  <InlineStack gap="200">
                                    <Button
                                      size="slim"
                                      onClick={() =>
                                        handleGenerateAltText(
                                          img.id,
                                          idx,
                                          product.images.length,
                                        )
                                      }
                                      loading={isGeneratingThis}
                                      disabled={
                                        !hasCredits(
                                          credits.creditsRemaining,
                                          CREDIT_COSTS.altTextGeneration,
                                        )
                                      }
                                    >
                                      {hasDraft ? "Regenerate" : "Generate"}
                                    </Button>
                                    <Button
                                      size="slim"
                                      variant="primary"
                                      tone="success"
                                      disabled={!hasDraft}
                                      loading={isApplyingThis}
                                      onClick={() => handleApplyAltText(img.id)}
                                    >
                                      Apply
                                    </Button>
                                  </InlineStack>
                                </BlockStack>
                              </div>
                            </InlineStack>
                          );
                        })}

                        {Object.values(altTextDrafts).some((v) =>
                          v?.trim(),
                        ) && (
                          <InlineStack align="end">
                            <Button
                              variant="primary"
                              tone="success"
                              onClick={handleApplyAllAltText}
                              loading={applyAltTextBulkFetcher.state !== "idle"}
                            >
                              Apply all drafts to Shopify
                            </Button>
                          </InlineStack>
                        )}
                      </BlockStack>
                    </Card>
                  )}
                </BlockStack>
              )}

              {selectedSections.length === 0 && (
                <Card>
                  <Box padding="400">
                    <Text as="p" tone="subdued" alignment="center">
                      Select at least one section above to get started.
                    </Text>
                  </Box>
                </Card>
              )}
            </BlockStack>
          </div>
        </Modal.Section>
      </Modal>
    </>
  );
}
