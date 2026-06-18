import { PLAN_CREDITS, PLAN_LABELS, type CreditPlan } from "./credits";

export const PLANS: Record<Uppercase<CreditPlan>, { name: string; monthlyCredits: number }> = {
  FREE: {
    name: PLAN_LABELS.free,
    monthlyCredits: PLAN_CREDITS.free,
  },
  BASIC: {
    name: PLAN_LABELS.basic,
    monthlyCredits: PLAN_CREDITS.basic,
  },
  STANDARD: {
    name: PLAN_LABELS.standard,
    monthlyCredits: PLAN_CREDITS.standard,
  },
  PRO: {
    name: PLAN_LABELS.pro,
    monthlyCredits: PLAN_CREDITS.pro,
  },
} as const;
