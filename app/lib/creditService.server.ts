import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "./db.server.ts";
import type { Plan } from "./rateLimiter.server.ts";

export const PLAN_CREDITS: Record<Plan, number> = {
  free: 100,
  basic: 6000,
  advanced: 20000,
  pro: 60000,
};

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Free",
  basic: "Basic",
  advanced: "Advanced",
  pro: "Pro",
};

export const CREDIT_COSTS = {
  descriptionGeneration: 1,
  seoOptimization: 2,
  keywordSuggestion: 0.5,
  bulkGenerationPerProduct: 1,
  standardGeneration: 1,
  enhancedSeoGeneration: 2,
  bulkProductGeneration: 1,
} as const;

export type CreditLedgerKind =
  | "grant"
  | "generation"
  | "bulk_generation"
  | "refund"
  | "regeneration"
  | "seo_generation"
  | "keyword_suggestion";

export interface CreditBalance {
  shopId: string;
  plan: Plan;
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  resetDate: Date;
}

export interface CreditResult extends CreditBalance {
  allowed: true;
  requestId: string;
  amount: number;
  alreadyApplied?: boolean;
}

export interface CreditFailure extends CreditBalance {
  allowed: false;
  requestId: string;
  amount: number;
  reason: "insufficient_credits";
}

function nextMonthlyResetDate(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function toDecimal(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Credit amount must be greater than zero");
  }
  return new Prisma.Decimal(value.toFixed(1));
}

function zeroDecimal() {
  return new Prisma.Decimal(0);
}

function asNumber(value: unknown) {
  if (value instanceof Prisma.Decimal) return value.toNumber();
  return Number(value ?? 0);
}

function stableTransactionId(shopId: string, requestId: string, kind: CreditLedgerKind) {
  return crypto.createHash("sha256").update(`${shopId}:${requestId}:${kind}`).digest("hex");
}

function monthlyGrantRequestId(shopId: string, resetDate: Date) {
  return `${shopId}:monthly-grant:${resetDate.toISOString().slice(0, 10)}`;
}

function serializeBalance(row: {
  shopId: string;
  plan: string;
  creditsUsed: Prisma.Decimal;
  creditsLimit: Prisma.Decimal;
  resetDate: Date;
}): CreditBalance {
  const creditsUsed = asNumber(row.creditsUsed);
  const creditsLimit = asNumber(row.creditsLimit);

  return {
    shopId: row.shopId,
    plan: row.plan as Plan,
    creditsUsed,
    creditsLimit,
    creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
    resetDate: row.resetDate,
  };
}

async function recordGrant(
  tx: Prisma.TransactionClient,
  shopId: string,
  plan: Plan,
  creditsLimit: Prisma.Decimal,
  resetDate: Date,
) {
  const requestId = monthlyGrantRequestId(shopId, resetDate);
  await tx.creditTransaction.upsert({
    where: {
      shopId_requestId_kind: {
        shopId,
        requestId,
        kind: "grant",
      },
    },
    update: {},
    create: {
      id: stableTransactionId(shopId, requestId, "grant"),
      shopId,
      requestId,
      kind: "grant",
      amount: creditsLimit,
      plan,
      metadata: { resetDate: resetDate.toISOString() },
    },
  });
}

async function ensureCycle(tx: Prisma.TransactionClient, shopId: string, plan: Plan) {
  if (!shopId) throw new Error("Missing shop context");

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shopId}))`;

  const now = new Date();
  const creditsLimit = new Prisma.Decimal(PLAN_CREDITS[plan].toFixed(1));
  const existing = await tx.shopCredit.findUnique({ where: { shopId } });

  if (!existing) {
    const resetDate = nextMonthlyResetDate(now);
    const created = await tx.shopCredit.create({
      data: {
        shopId,
        plan,
        creditsLimit,
        creditsUsed: zeroDecimal(),
        resetDate,
      },
    });
    await recordGrant(tx, shopId, plan, creditsLimit, resetDate);
    return created;
  }

  if (existing.resetDate <= now) {
    const resetDate = nextMonthlyResetDate(now);
    const updated = await tx.shopCredit.update({
      where: { shopId },
      data: {
        plan,
        creditsLimit,
        creditsUsed: zeroDecimal(),
        resetDate,
      },
    });
    await recordGrant(tx, shopId, plan, creditsLimit, resetDate);
    return updated;
  }

  if (existing.plan !== plan || !existing.creditsLimit.equals(creditsLimit)) {
    return tx.shopCredit.update({
      where: { shopId },
      data: { plan, creditsLimit },
    });
  }

  return existing;
}

export async function ensureMonthlyCredits(shopId: string, plan: Plan) {
  return db.$transaction(async (tx) => {
    const row = await ensureCycle(tx, shopId, plan);
    return serializeBalance(row);
  });
}

export async function getShopCredits(shopId: string, plan?: Plan) {
  const existing = await db.shopCredit.findUnique({ where: { shopId } });
  const effectivePlan = plan ?? ((existing?.plan as Plan | undefined) ?? "free");
  return ensureMonthlyCredits(shopId, effectivePlan);
}

export async function getCreditBalance(shopId: string, plan: Plan) {
  return ensureMonthlyCredits(shopId, plan);
}

export async function getRemainingCredits(shopId: string, plan?: Plan) {
  const balance = await getShopCredits(shopId, plan);
  return balance.creditsRemaining;
}

export async function deductCredits({
  shopId,
  plan,
  amount,
  requestId,
  kind = "generation",
  metadata,
}: {
  shopId: string;
  plan?: Plan;
  amount: number;
  requestId?: string;
  kind?: Exclude<CreditLedgerKind, "grant" | "refund">;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditResult | CreditFailure> {
  const resolvedRequestId = requestId ?? crypto.randomUUID();
  const existing = plan ? null : await db.shopCredit.findUnique({ where: { shopId } });
  const effectivePlan = plan ?? ((existing?.plan as Plan | undefined) ?? "free");

  return db.$transaction(async (tx) => {
    const current = await ensureCycle(tx, shopId, effectivePlan);
    const existingDebit = await tx.creditTransaction.findUnique({
      where: {
        shopId_requestId_kind: {
          shopId,
          requestId: resolvedRequestId,
          kind,
        },
      },
    });

    if (existingDebit) {
      return {
        ...serializeBalance(current),
        allowed: true,
        requestId: resolvedRequestId,
        amount,
        alreadyApplied: true,
      };
    }

    const updated = await tx.shopCredit.updateMany({
      where: {
        shopId,
        creditsUsed: {
          lte: new Prisma.Decimal(current.creditsLimit).minus(amount),
        },
      },
      data: {
        creditsUsed: { increment: toDecimal(amount) },
        plan: effectivePlan,
        creditsLimit: new Prisma.Decimal(PLAN_CREDITS[effectivePlan].toFixed(1)),
      },
    });

    if (updated.count !== 1) {
      const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
      return {
        ...serializeBalance(fresh),
        allowed: false,
        requestId: resolvedRequestId,
        reason: "insufficient_credits",
        amount,
      };
    }

    await tx.creditTransaction.create({
      data: {
        id: stableTransactionId(shopId, resolvedRequestId, kind),
        shopId,
        requestId: resolvedRequestId,
        kind,
        amount: toDecimal(amount),
        plan: effectivePlan,
        metadata,
      },
    });

    const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
    return {
      ...serializeBalance(fresh),
      allowed: true,
      requestId: resolvedRequestId,
      amount,
    };
  });
}

export async function refundCredits({
  shopId,
  plan,
  amount,
  requestId,
  kind = "refund",
  metadata,
}: {
  shopId: string;
  plan?: Plan;
  amount: number;
  requestId: string;
  kind?: "refund";
  metadata?: Prisma.InputJsonValue;
}) {
  const existing = await db.shopCredit.findUnique({ where: { shopId } });
  const effectivePlan = plan ?? ((existing?.plan as Plan | undefined) ?? "free");

  return db.$transaction(async (tx) => {
    const current = await ensureCycle(tx, shopId, effectivePlan);
    const existingRefund = await tx.creditTransaction.findUnique({
      where: {
        shopId_requestId_kind: {
          shopId,
          requestId,
          kind,
        },
      },
    });

    if (existingRefund) {
      return {
        refunded: false,
        alreadyApplied: true,
        ...serializeBalance(current),
      };
    }

    await tx.shopCredit.update({
      where: { shopId },
      data: {
        creditsUsed: { decrement: toDecimal(amount) },
        plan: effectivePlan,
        creditsLimit: new Prisma.Decimal(PLAN_CREDITS[effectivePlan].toFixed(1)),
      },
    });

    await tx.$executeRaw`
      UPDATE "ShopCredit"
      SET "creditsUsed" = 0
      WHERE "shopId" = ${shopId} AND "creditsUsed" < 0
    `;

    await tx.creditTransaction.create({
      data: {
        id: stableTransactionId(shopId, requestId, kind),
        shopId,
        requestId,
        kind,
        amount: toDecimal(amount),
        plan: effectivePlan,
        metadata,
      },
    });

    const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
    return {
      refunded: true,
      ...serializeBalance(fresh),
    };
  });
}
