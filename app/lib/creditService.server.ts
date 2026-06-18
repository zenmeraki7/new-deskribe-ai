import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "./db.server";
import type { Plan } from "./rateLimiter.server";
import { CREDIT_COSTS, PLAN_CREDITS } from "./credits";
import {
  consumeCreditWithIdempotency,
  getCreditStatus,
  InsufficientCreditsError,
  syncShopPlan,
} from "../utils/credits.server";
import { appLog, durationSince } from "../utils/observability.server";

export { CREDIT_COSTS, PLAN_CREDITS, InsufficientCreditsError };

export type CreditDebitKind =
  | "generation"
  | "bulk_generation"
  | "regeneration"
  | "keyword_suggestion";

type CreditKind = CreditDebitKind | "refund";

export interface CreditResult {
  allowed: true;
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

function stableTransactionId(requestId: string, kind: CreditKind) {
  return crypto
    .createHash("sha256")
    .update(`${kind}:${requestId}`)
    .digest("hex");
}

function toDecimal(value: number) {
  return new Prisma.Decimal(value.toFixed(1));
}

export async function getCreditBalance(shopId: string, plan: Plan) {
  await syncShopPlan(shopId, plan, { createIfMissing: true });
  const status = await getCreditStatus(shopId);

  return {
    shopId,
    plan: status.plan,
    creditsUsed: status.creditsUsed,
    creditsLimit: status.creditLimit,
    creditsRemaining: status.remaining,
    resetDate: status.cycleEndsAt,
    cycleEndsAt: status.cycleEndsAt,
  };
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
  plan: Plan;
  amount: number;
  requestId?: string;
  kind?: CreditDebitKind;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditResult | CreditFailure> {
  const startedAt = Date.now();
  if (!shopId) throw new Error("Missing shop context");
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Credit deduction amount must be a positive integer");
  }

  await syncShopPlan(shopId, plan, { createIfMissing: true });
  const resolvedRequestId = requestId ?? crypto.randomUUID();

  const existingDebit = await db.creditTransaction.findUnique({
    where: {
      shopId_requestId_kind: {
        shopId,
        requestId: resolvedRequestId,
        kind,
      },
    },
  });

  if (existingDebit) {
    const status = await getCreditStatus(shopId);
    appLog.info("Credit deduction reused existing transaction", {
      operation: "credits.deduct",
      shop: shopId,
      requestId: resolvedRequestId,
      durationMs: durationSince(startedAt),
      status: "already_applied",
      amount,
      kind,
    });
    appLog.info("Credit deduction applied", {
      operation: "credits.deduct",
      shop: shopId,
      requestId: resolvedRequestId,
      durationMs: durationSince(startedAt),
      status: "applied",
      amount,
      kind,
      creditsUsed: status.creditsUsed,
      creditsLimit: status.creditLimit,
      creditsRemaining: status.remaining,
    });

    return {
      allowed: true,
      requestId: resolvedRequestId,
      amount,
      creditsUsed: status.creditsUsed,
      creditsLimit: status.creditLimit,
      creditsRemaining: status.remaining,
      resetDate: status.cycleEndsAt,
      alreadyApplied: true,
    };
  }

  try {
    const status = await consumeCreditWithIdempotency(
      shopId,
      kind,
      amount,
      resolvedRequestId,
    );

    if (!("alreadyApplied" in status && status.alreadyApplied)) {
      try {
        await db.creditTransaction.create({
          data: {
            id: stableTransactionId(resolvedRequestId, kind),
            shopId,
            requestId: resolvedRequestId,
            kind,
            amount: toDecimal(amount),
            plan: status.plan,
            metadata,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
      }
    }

    return {
      allowed: true,
      requestId: resolvedRequestId,
      amount,
      creditsUsed: status.creditsUsed,
      creditsLimit: status.creditLimit,
      creditsRemaining: status.remaining,
      resetDate: status.cycleEndsAt,
    };
  } catch (error) {
    if (!(error instanceof InsufficientCreditsError)) throw error;
    const status = await getCreditStatus(shopId);
    appLog.warn("Credit deduction blocked by limit", {
      operation: "credits.deduct",
      shop: shopId,
      requestId: resolvedRequestId,
      durationMs: durationSince(startedAt),
      status: "insufficient_credits",
      amount,
      kind,
      creditsUsed: status.creditsUsed,
      creditsLimit: status.creditLimit,
    });
    return {
      allowed: false,
      requestId: resolvedRequestId,
      reason: "insufficient_credits",
      amount,
      creditsUsed: status.creditsUsed,
      creditsLimit: status.creditLimit,
      creditsRemaining: status.remaining,
      resetDate: status.cycleEndsAt,
    };
  }
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
  const startedAt = Date.now();
  if (!shopId) throw new Error("Missing shop context");
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Credit refund amount must be a positive integer");
  }

  if (plan) await syncShopPlan(shopId, plan, { createIfMissing: true });

  return db.$transaction(
    async (tx) => {
      const existingRefund = await tx.creditTransaction.findUnique({
        where: {
          shopId_requestId_kind: { shopId, requestId, kind: "refund" },
        },
      });

      const current = await tx.shopCredit.findUniqueOrThrow({
        where: { shopId },
        include: { planRef: true },
      });

      if (existingRefund) {
        appLog.info("Credit refund reused existing transaction", {
          operation: "credits.refund",
          shop: shopId,
          requestId,
          durationMs: durationSince(startedAt),
          status: "already_applied",
          amount,
        });
        return {
          refunded: false,
          alreadyApplied: true,
          creditsUsed: current.creditsUsed,
          creditsLimit: current.planRef.creditLimit,
          resetDate: current.cycleEndsAt,
        };
      }

      await tx.shopCredit.update({
        where: { shopId },
        data: {
          creditsUsed: { decrement: amount },
        },
      });

      await tx.$executeRaw`
        UPDATE "ShopCredit"
        SET "creditsUsed" = 0
        WHERE "shopId" = ${shopId} AND "creditsUsed" < 0
      `;

      await tx.creditTransaction.create({
        data: {
          id: stableTransactionId(requestId, "refund"),
          shopId,
          requestId,
          kind: "refund",
          amount: toDecimal(amount),
          plan: current.planRef.name,
          metadata,
        },
      });

      const fresh = await tx.shopCredit.findUniqueOrThrow({
        where: { shopId },
        include: { planRef: true },
      });

      appLog.info("Credit refund applied", {
        operation: "credits.refund",
        shop: shopId,
        requestId,
        durationMs: durationSince(startedAt),
        status: "applied",
        amount,
        creditsUsed: fresh.creditsUsed,
        creditsLimit: fresh.planRef.creditLimit,
      });

      return {
        refunded: true,
        creditsUsed: fresh.creditsUsed,
        creditsLimit: fresh.planRef.creditLimit,
        resetDate: fresh.cycleEndsAt,
      };
    },
    { timeout: 15000 },
  );
}
