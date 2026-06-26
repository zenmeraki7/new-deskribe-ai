import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "./db.server";
import type { Plan } from "./rateLimiter.server";
import { CREDIT_COSTS, PLAN_CREDITS } from "./credits";

export { CREDIT_COSTS, PLAN_CREDITS };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CreditDebitKind =
  | "generation"
  | "bulk_generation"
  | "regeneration"
  | "keyword_suggestion";

type CreditKind = "grant" | CreditDebitKind | "refund";

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function nextMonthlyResetDate(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}

function toDecimal(value: number) {
  return new Prisma.Decimal(value.toFixed(1));
}

function asNumber(value: unknown) {
  if (value instanceof Prisma.Decimal) return value.toNumber();
  return Number(value ?? 0);
}

function stableTransactionId(requestId: string, kind: CreditKind) {
  return crypto
    .createHash("sha256")
    .update(`${kind}:${requestId}`)
    .digest("hex");
}

function grantRequestId(
  shopId: string,
  plan: Plan,
  resetDate: Date,
  creditsLimit: Prisma.Decimal,
) {
  return `grant:${shopId}:${plan}:${resetDate.toISOString()}:${creditsLimit.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: recordGrant + ensureCycle (write path only — used by deduct/refund)
// ─────────────────────────────────────────────────────────────────────────────

async function recordGrant(
  tx: Prisma.TransactionClient,
  row: {
    shopId: string;
    plan: string;
    resetDate: Date;
    creditsLimit: Prisma.Decimal;
  },
) {
  const requestId = grantRequestId(
    row.shopId,
    row.plan as Plan,
    row.resetDate,
    row.creditsLimit,
  );
  await tx.creditTransaction.upsert({
    where: {
      shopId_requestId_kind: {
        shopId: row.shopId,
        requestId,
        kind: "grant",
      },
    },
    create: {
      id: stableTransactionId(requestId, "grant"),
      shopId: row.shopId,
      requestId,
      kind: "grant",
      amount: row.creditsLimit,
      plan: row.plan,
      metadata: {
        resetDate: row.resetDate.toISOString(),
        creditsLimit: row.creditsLimit.toString(),
      },
    },
    update: {},
  });
}

async function ensureCycle(
  tx: Prisma.TransactionClient,
  shopId: string,
  plan: Plan,
) {
  // Advisory lock prevents concurrent ensureCycle calls for the same shop
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1::text))`,
    shopId,
  );

  const now = new Date();
  const creditsLimit = toDecimal(PLAN_CREDITS[plan]);

  const existing = await tx.shopCredit.findUnique({ where: { shopId } });

console.log("creditsLimit value:", existing.creditsLimit);
console.log("typeof:", typeof existing.creditsLimit);
console.log("constructor:", existing.creditsLimit?.constructor?.name);

  if (!existing) {
    const created = await tx.shopCredit.create({
      data: {
        shopId,
        plan,
        creditsLimit,
        creditsUsed: toDecimal(0),
        resetDate: nextMonthlyResetDate(now),
      },
    });
    await recordGrant(tx, created);
    return created;
  }

  if (existing.resetDate <= now) {
    const reset = await tx.shopCredit.update({
      where: { shopId },
      data: {
        plan,
        creditsLimit,
        creditsUsed: toDecimal(0),
        resetDate: nextMonthlyResetDate(now),
      },
    });
    await recordGrant(tx, reset);
    return reset;
  }

  if (
    existing.plan !== plan ||
    asNumber(existing.creditsLimit) !== asNumber(creditsLimit)
  ) {
    const updated = await tx.shopCredit.update({
      where: { shopId },
      data: { plan, creditsLimit },
    });
    await recordGrant(tx, updated);
    return updated;
  }

  await recordGrant(tx, existing);
  return existing;
}

// ─────────────────────────────────────────────────────────────────────────────
// getCreditBalance — READ ONLY, no transaction, no lock, safe for loaders
// ─────────────────────────────────────────────────────────────────────────────

export async function getCreditBalance(shopId: string, plan: Plan) {
  if (!shopId) throw new Error("Missing shop context");

  const existing = await db.shopCredit.findUnique({ where: { shopId } });

  if (!existing) {
    const creditsLimit = PLAN_CREDITS[plan];
    return {
      shopId,
      plan,
      creditsUsed: 0,
      creditsLimit,
      creditsRemaining: creditsLimit,
      resetDate: nextMonthlyResetDate(),
    };
  }

  const now = new Date();

  if (existing.resetDate <= now) {
    const creditsLimit = PLAN_CREDITS[plan];
    return {
      shopId,
      plan,
      creditsUsed: 0,
      creditsLimit,
      creditsRemaining: creditsLimit,
      resetDate: nextMonthlyResetDate(now),
    };
  }

  const creditsUsed = asNumber(existing.creditsUsed);
  const creditsLimit = asNumber(existing.creditsLimit);

  return {
    shopId,
    plan: existing.plan as Plan,
    creditsUsed,
    creditsLimit,
    creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
    resetDate: existing.resetDate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// deductCredits — write path, uses ensureCycle inside transaction
// ─────────────────────────────────────────────────────────────────────────────

export async function deductCredits({
  shopId,
  plan,
  amount,
  requestId,
  kind = "generation",
  metadata,
}: {
  shopId: string;
  plan: Plan;
  amount: number;
  requestId?: string;
  kind?: CreditDebitKind;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditResult | CreditFailure> {
  if (!shopId) throw new Error("Missing shop context");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Credit deduction amount must be greater than zero");
  }

  const resolvedRequestId = requestId ?? crypto.randomUUID();

  return db.$transaction(
    async (tx) => {
      const current = await ensureCycle(tx, shopId, plan);

      // Idempotency: if this exact request was already applied, return early
      const existingDebit = await tx.creditTransaction.findUnique({
        where: {
          shopId_requestId_kind: { shopId, requestId: resolvedRequestId, kind },
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
        } satisfies CreditResult;
      }

      // Atomic deduction via raw SQL — bypasses Prisma binary encoding issues
      const maxAllowed = (asNumber(current.creditsLimit) - amount).toFixed(1);
      const amountStr = amount.toFixed(1);
      const newLimit = PLAN_CREDITS[plan].toFixed(1);

      const result = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "ShopCredit"
         SET "creditsUsed" = "creditsUsed" + $1::numeric,
             "plan" = $2,
             "creditsLimit" = $3::numeric,
             "updatedAt" = now()
         WHERE "shopId" = $4
         AND "creditsUsed" <= $5::numeric
         RETURNING "id"`,
        amountStr,
        plan,
        newLimit,
        shopId,
        maxAllowed,
      );

      const updatedCount = result.length;

      if (updatedCount !== 1) {
        const fresh = await tx.shopCredit.findUniqueOrThrow({
          where: { shopId },
        });
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
        } satisfies CreditFailure;
      }

      await tx.creditTransaction.create({
        data: {
          id: stableTransactionId(resolvedRequestId, kind),
          shopId,
          requestId: resolvedRequestId,
          kind,
          amount: toDecimal(amount),
          plan,
          metadata,
        },
      });

      const fresh = await tx.shopCredit.findUniqueOrThrow({
        where: { shopId },
      });
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
      } satisfies CreditResult;
    },
    { timeout: 15000 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// refundCredits — write path, uses ensureCycle inside transaction
// ─────────────────────────────────────────────────────────────────────────────

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
  if (!shopId) throw new Error("Missing shop context");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Credit refund amount must be greater than zero");
  }

  return db.$transaction(
    async (tx) => {
      const existingCredit = await tx.shopCredit.findUnique({
        where: { shopId },
      });
      const effectivePlan =
        plan ?? ((existingCredit?.plan as Plan | undefined) ?? "free");
      const current = await ensureCycle(tx, shopId, effectivePlan);

      // Idempotency check
      const existingRefund = await tx.creditTransaction.findUnique({
        where: {
          shopId_requestId_kind: { shopId, requestId, kind: "refund" },
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

      // Refund via raw SQL — same reason as deductCredits
      const amountStr = amount.toFixed(1);
      const newLimit = PLAN_CREDITS[effectivePlan].toFixed(1);

      await tx.$executeRawUnsafe(
        `UPDATE "ShopCredit"
         SET "creditsUsed" = GREATEST(0, "creditsUsed" - $1::numeric),
             "plan" = $2,
             "creditsLimit" = $3::numeric,
             "updatedAt" = now()
         WHERE "shopId" = $4`,
        amountStr,
        effectivePlan,
        newLimit,
        shopId,
      );

      await tx.creditTransaction.create({
        data: {
          id: stableTransactionId(requestId, "refund"),
          shopId,
          requestId,
          kind: "refund",
          amount: toDecimal(amount),
          plan: effectivePlan,
          metadata,
        },
      });

      const fresh = await tx.shopCredit.findUniqueOrThrow({
        where: { shopId },
      });
      return {
        refunded: true,
        creditsUsed: asNumber(fresh.creditsUsed),
        creditsLimit: asNumber(fresh.creditsLimit),
        resetDate: fresh.resetDate,
      };
    },
    { timeout: 15000 },
  );
}