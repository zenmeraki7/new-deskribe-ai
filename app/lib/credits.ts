export type CreditPlan = "free" | "basic" | "advanced" | "pro";

export const PLAN_CREDITS: Record<CreditPlan, number> = {
  free: 100,
  basic: 6000,
  advanced: 20000,
  pro: 60000,
};

export const CREDIT_COSTS = {
  standardGeneration: 1,
  enhancedSeoGeneration: 2,
  bulkProductGeneration: 1,
  keywordSuggestion: 0.5,
} as const;

export const CREDIT_RULES = [
  { label: "1 product description", credits: CREDIT_COSTS.standardGeneration },
  { label: "SEO generation", credits: CREDIT_COSTS.enhancedSeoGeneration },
  { label: "Keyword suggestion", credits: CREDIT_COSTS.keywordSuggestion },
  {
    label: "Bulk generation",
    credits: CREDIT_COSTS.bulkProductGeneration,
    suffix: "per product",
  },
] as const;

export const PLAN_LABELS: Record<CreditPlan, string> = {
  free: "Free",
  basic: "Basic Plan",
  advanced: "Advanced Plan",
  pro: "Pro Plan",
};

export function usageProgress(creditsUsed: number, creditsLimit: number) {
  if (creditsLimit <= 0) return 0;
  return Math.min(100, Math.max(0, (creditsUsed / creditsLimit) * 100));
}

export function hasCredits(creditsRemaining: number, cost: number) {
  return creditsRemaining >= cost;
}
