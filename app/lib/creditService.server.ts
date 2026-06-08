import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "./db.server";
import type { Plan } from "./rateLimiter.server";

export const PLAN_CREDITS: Record<Plan, number> = {
  free: 100,
  basic: 6000,
  advanced: 20000,
  pro: 50000,
};

export const CREDIT_COSTS = {
  standardGeneration: 1,
  enhancedSeoGeneration: 2,
  bulkProductGeneration: 1,
  keywordSuggestion: 0.5,
} as const;

type CreditKind = "DEBIT" | "REFUND";

export interface CreditResult {
  allowed: boolean;
  requestId: string;
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  amount: number;
  resetDate: Date;
  alreadyApplied?: boolean;
}

export interface CreditFailure {
  allowed: false;
  requestId: string;
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  amount: number;
  resetDate: Date;
  reason: "insufficient_credits";
}

function nextMonthlyResetDate(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function toDecimal(value: number) {
  return new Prisma.Decimal(value.toFixed(1));
}

function asNumber(value: unknown) {
  if (value instanceof Prisma.Decimal) return value.toNumber();
  return Number(value ?? 0);
}

function stableTransactionId(requestId: string, kind: CreditKind) {
  return crypto.createHash("sha256").update(`${kind}:${requestId}`).digest("hex");
}

async function ensureCycle(tx: Prisma.TransactionClient, shopId: string, plan: Plan) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shopId}))`;

  const now = new Date();
  const creditsLimit = toDecimal(PLAN_CREDITS[plan]);

  const existing = await tx.shopCredit.findUnique({ where: { shopId } });
  if (!existing) {
    return tx.shopCredit.create({
      data: {
        shopId,
        plan,
        creditsLimit,
        creditsUsed: toDecimal(0),
        resetDate: nextMonthlyResetDate(now),
      },
    });
  }

  if (existing.resetDate <= now) {
    return tx.shopCredit.update({
      where: { shopId },
      data: {
        plan,
        creditsLimit,
        creditsUsed: toDecimal(0),
        resetDate: nextMonthlyResetDate(now),
      },
    });
  }

  if (existing.plan !== plan || !existing.creditsLimit.equals(creditsLimit)) {
    return tx.shopCredit.update({
      where: { shopId },
      data: { plan, creditsLimit },
    });
  }

  return existing;
}

export async function getCreditBalance(shopId: string, plan: Plan) {
  return db.$transaction(async (tx) => {
    const row = await ensureCycle(tx, shopId, plan);
    const creditsUsed = asNumber(row.creditsUsed);
    const creditsLimit = asNumber(row.creditsLimit);
    return {
      shopId,
      plan: row.plan as Plan,
      creditsUsed,
      creditsLimit,
      creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
      resetDate: row.resetDate,
    };
  });
}

export async function deductCredits({
  shopId,
  plan,
  amount,
  requestId,
  metadata,
}: {
  shopId: string;
  plan: Plan;
  amount: number;
  requestId?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditResult | CreditFailure> {
  const resolvedRequestId = requestId ?? crypto.randomUUID();

  return db.$transaction(async (tx) => {
    const current = await ensureCycle(tx, shopId, plan);
    const existingDebit = await tx.creditTransaction.findUnique({
      where: {
        shopId_requestId_kind: {
          shopId,
          requestId: resolvedRequestId,
          kind: "DEBIT",
        },
      },
    });

    if (existingDebit) {
      const creditsUsed = asNumber(current.creditsUsed);
      const creditsLimit = asNumber(current.creditsLimit);
      return {
        allowed: true,
        requestId: resolvedRequestId,
        amount,
        creditsUsed,
        creditsLimit,
        creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
        resetDate: current.resetDate,
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
        plan,
        creditsLimit: toDecimal(PLAN_CREDITS[plan]),
      },
    });

    if (updated.count !== 1) {
      const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
      const creditsUsed = asNumber(fresh.creditsUsed);
      const creditsLimit = asNumber(fresh.creditsLimit);
      return {
        allowed: false,
        requestId: resolvedRequestId,
        reason: "insufficient_credits",
        amount,
        creditsUsed,
        creditsLimit,
        creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
        resetDate: fresh.resetDate,
      };
    }

    await tx.creditTransaction.create({
      data: {
        id: stableTransactionId(resolvedRequestId, "DEBIT"),
        shopId,
        requestId: resolvedRequestId,
        kind: "DEBIT",
        amount: toDecimal(amount),
        plan,
        metadata,
      },
    });

    const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
    const creditsUsed = asNumber(fresh.creditsUsed);
    const creditsLimit = asNumber(fresh.creditsLimit);
    return {
      allowed: true,
      requestId: resolvedRequestId,
      amount,
      creditsUsed,
      creditsLimit,
      creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
      resetDate: fresh.resetDate,
    };
  });
}

export async function refundCredits({
  shopId,
  plan,
  amount,
  requestId,
  metadata,
}: {
  shopId: string;
  plan?: Plan;
  amount: number;
  requestId: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return db.$transaction(async (tx) => {
    const existingCredit = await tx.shopCredit.findUnique({ where: { shopId } });
    const effectivePlan = plan ?? ((existingCredit?.plan as Plan | undefined) ?? "free");
    const current = await ensureCycle(tx, shopId, effectivePlan);
    const existingRefund = await tx.creditTransaction.findUnique({
      where: {
        shopId_requestId_kind: {
          shopId,
          requestId,
          kind: "REFUND",
        },
      },
    });

    if (existingRefund) {
      return {
        refunded: false,
        alreadyApplied: true,
        creditsUsed: asNumber(current.creditsUsed),
        creditsLimit: asNumber(current.creditsLimit),
        resetDate: current.resetDate,
      };
    }

    await tx.shopCredit.update({
      where: { shopId },
      data: {
        creditsUsed: { decrement: toDecimal(amount) },
        plan: effectivePlan,
        creditsLimit: toDecimal(PLAN_CREDITS[effectivePlan]),
      },
    });

    await tx.$executeRaw`
      UPDATE "ShopCredit"
      SET "creditsUsed" = 0
      WHERE "shopId" = ${shopId} AND "creditsUsed" < 0
    `;

    await tx.creditTransaction.create({
      data: {
        id: stableTransactionId(requestId, "REFUND"),
        shopId,
        requestId,
        kind: "REFUND",
        amount: toDecimal(amount),
        plan: effectivePlan,
        metadata,
      },
    });

    const fresh = await tx.shopCredit.findUniqueOrThrow({ where: { shopId } });
    return {
      refunded: true,
      creditsUsed: asNumber(fresh.creditsUsed),
      creditsLimit: asNumber(fresh.creditsLimit),
      resetDate: fresh.resetDate,
    };
  });
}
