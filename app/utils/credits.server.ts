import { db } from "../lib/db.server";
import { PLAN_CREDITS, type CreditPlan } from "../lib/credits";

type CreditDb = typeof db | Parameters<Parameters<typeof db.$transaction>[0]>[0];

export class InsufficientCreditsError extends Error {
  shop: string;
  limit: number;

  constructor(shop: string, limit: number) {
    super(`Credit limit reached for ${shop}. Monthly limit: ${limit}.`);
    this.name = "InsufficientCreditsError";
    this.shop = shop;
    this.limit = limit;
  }
}

export type CreditStatus = {
  plan: CreditPlan;
  creditsUsed: number;
  creditLimit: number;
  remaining: number;
  cycleEndsAt: Date;
};

function addOneMonth(date: Date) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function normalizePlanName(plan: string | null | undefined): CreditPlan {
  const lower = String(plan ?? "free").toLowerCase();
  if (lower.includes("pro")) return "pro";
  if (lower.includes("standard") || lower.includes("advanced")) return "standard";
  if (lower.includes("basic")) return "basic";
  return "free";
}

async function ensurePlan(planName: CreditPlan, tx: CreditDb = db) {
  return tx.plan.upsert({
    where: { name: planName },
    create: { name: planName, creditLimit: PLAN_CREDITS[planName] },
    update: { creditLimit: PLAN_CREDITS[planName] },
  });
}

async function ensureShopCreditRow(
  shop: string,
  planName: CreditPlan,
  tx: CreditDb = db,
) {
  const plan = await ensurePlan(planName, tx);
  const now = new Date();

  return tx.shopCredit.upsert({
    where: { shopId: shop },
    create: {
      shopId: shop,
      plan: plan.name,
      planId: plan.id,
      creditsUsed: 0,
      creditsLimit: plan.creditLimit,
      cycleStartsAt: now,
      cycleEndsAt: addOneMonth(now),
      resetDate: addOneMonth(now),
    },
    update: {},
    include: { planRef: true },
  });
}

export async function ensureShopCreditForShop(
  shop: string,
  planName: CreditPlan = "free",
) {
  if (!shop) throw new Error("Missing shop context");
  return ensureShopCreditRow(shop, planName);
}

export async function syncShopPlan(
  shop: string,
  subscriptionName: string | null | undefined,
  options: { createIfMissing?: boolean } = {},
) {
  if (!shop) throw new Error("Missing shop context");

  const planName = normalizePlanName(subscriptionName);
  const plan = await ensurePlan(planName);
  const existing = await db.shopCredit.findUnique({ where: { shopId: shop } });

  if (!existing) {
    if (!options.createIfMissing) {
      console.warn(`[credits] Plan sync skipped for unknown shop ${shop}`);
      return null;
    }
    return ensureShopCreditRow(shop, planName);
  }

  return db.shopCredit.update({
    where: { shopId: shop },
    data: {
      plan: plan.name,
      planId: plan.id,
      creditsLimit: plan.creditLimit,
    },
    include: { planRef: true },
  });
}

async function resetExpiredCycle(shop: string, tx: CreditDb = db) {
  const now = new Date();
  const row = await tx.shopCredit.findUnique({
    where: { shopId: shop },
    include: { planRef: true },
  });

  if (!row) return ensureShopCreditRow(shop, "free", tx);
  if (row.cycleEndsAt > now) return row;

  const cycleEndsAt = addOneMonth(now);
  // Reset happens before any limit check so a shop gets its new rolling month
  // even when the next request arrives after the previous cycle expired.
  return tx.shopCredit.update({
    where: { shopId: shop },
    data: {
      creditsUsed: 0,
      cycleStartsAt: now,
      cycleEndsAt,
      resetDate: cycleEndsAt,
      creditsLimit: row.planRef.creditLimit,
    },
    include: { planRef: true },
  });
}

export async function consumeCredit(shop: string, action: string, amount = 1) {
  return consumeCreditWithIdempotency(shop, action, amount);
}

export async function consumeCreditWithIdempotency(
  shop: string,
  action: string,
  amount = 1,
  idempotencyKey?: string | null,
) {
  if (!shop) throw new Error("Missing shop context");
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Credit amount must be a positive integer");
  }

  const result = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;
      const current = await resetExpiredCycle(shop, tx);
      const creditLimit = current.planRef.creditLimit;

      if (idempotencyKey) {
        const existingLog = await tx.creditUsageLog.findFirst({
          where: { shop, idempotencyKey },
        });

        if (existingLog) {
          const fresh = await tx.shopCredit.findUniqueOrThrow({
            where: { shopId: shop },
            include: { planRef: true },
          });
          return {
            ok: true as const,
            alreadyApplied: true,
            plan: fresh.planRef.name as CreditPlan,
            creditsUsed: fresh.creditsUsed,
            creditLimit: fresh.planRef.creditLimit,
            remaining: Math.max(0, fresh.planRef.creditLimit - fresh.creditsUsed),
            cycleEndsAt: fresh.cycleEndsAt,
          };
        }
      }

      const updated = await tx.$executeRaw`
        UPDATE "ShopCredit"
        SET
          "creditsUsed" = "creditsUsed" + ${amount},
          "creditsLimit" = (
            SELECT "creditLimit"
            FROM "Plan"
            WHERE "Plan"."id" = "ShopCredit"."planId"
          )
        WHERE "shopId" = ${shop}
          AND "creditsUsed" + ${amount} <= (
            SELECT "creditLimit"
            FROM "Plan"
            WHERE "Plan"."id" = "ShopCredit"."planId"
          )
      `;

      if (updated === 0) {
        if (idempotencyKey) {
          const existingLog = await tx.creditUsageLog.findFirst({
            where: { shop, idempotencyKey },
          });

          if (existingLog) {
            const fresh = await tx.shopCredit.findUniqueOrThrow({
              where: { shopId: shop },
              include: { planRef: true },
            });
            return {
              ok: true as const,
              alreadyApplied: true,
              plan: fresh.planRef.name as CreditPlan,
              creditsUsed: fresh.creditsUsed,
              creditLimit: fresh.planRef.creditLimit,
              remaining: Math.max(0, fresh.planRef.creditLimit - fresh.creditsUsed),
              cycleEndsAt: fresh.cycleEndsAt,
            };
          }
        }

        return {
          ok: false as const,
          creditsUsed: current.creditsUsed,
          creditLimit,
          cycleEndsAt: current.cycleEndsAt,
        };
      }

      await tx.creditUsageLog.create({
        data: { shop, action, amount, idempotencyKey: idempotencyKey ?? null },
      });

      const fresh = await tx.shopCredit.findUniqueOrThrow({
        where: { shopId: shop },
        include: { planRef: true },
      });

      return {
        ok: true as const,
        plan: fresh.planRef.name as CreditPlan,
        creditsUsed: fresh.creditsUsed,
        creditLimit: fresh.planRef.creditLimit,
        remaining: Math.max(0, fresh.planRef.creditLimit - fresh.creditsUsed),
        cycleEndsAt: fresh.cycleEndsAt,
      };
    },
    { timeout: 15000 },
  ).catch(async (error) => {
    if (!idempotencyKey || error?.code !== "P2002") throw error;
    const status = await getCreditStatus(shop);
    return {
      ok: true as const,
      alreadyApplied: true,
      plan: status.plan,
      creditsUsed: status.creditsUsed,
      creditLimit: status.creditLimit,
      remaining: status.remaining,
      cycleEndsAt: status.cycleEndsAt,
    };
  });

  if (!result.ok) {
    throw new InsufficientCreditsError(shop, result.creditLimit);
  }

  return result;
}

export async function getCreditStatus(shop: string): Promise<CreditStatus> {
  if (!shop) throw new Error("Missing shop context");

  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;
    return resetExpiredCycle(shop, tx);
  });

  const creditLimit = row.planRef.creditLimit;
  return {
    plan: row.planRef.name as CreditPlan,
    creditsUsed: row.creditsUsed,
    creditLimit,
    remaining: Math.max(0, creditLimit - row.creditsUsed),
    cycleEndsAt: row.cycleEndsAt,
  };
}

export { normalizePlanName };
