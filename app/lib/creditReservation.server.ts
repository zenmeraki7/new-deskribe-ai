import type { Prisma } from "@prisma/client";

import {
  deductCredits,
  refundCredits,
  type CreditDebitKind,
  type CreditFailure,
  type CreditResult,
  type CreditRefundResult,
} from "./creditService.server";
import type { Plan } from "./rateLimiter.server";

type ReserveCreditsParams = {
  shopId: string;
  plan: Plan;
  amount: number;
  requestId: string;
  kind: CreditDebitKind;
  metadata?: Prisma.InputJsonValue;
};

type RollbackParams = {
  suffix: string;
  amount?: number;
  metadata?: Prisma.InputJsonValue;
};

type AlreadyRolledBackResult = {
  ok: false;
  error: "already_rolled_back";
};

export type CreditReservation = Omit<CreditResult, "creditsRemaining"> & {
  remainingAfterReservation: number;
  rollback: (
    params: RollbackParams,
  ) => Promise<CreditRefundResult | AlreadyRolledBackResult>;
};

export async function reserveCredits(
  params: ReserveCreditsParams,
): Promise<CreditReservation | CreditFailure> {
  const credit = await deductCredits(params);

  if (!credit.allowed) {
    return credit;
  }

  let rolledBack = false;
  const { creditsRemaining, ...reservationCredit } = credit;

  return {
    ...reservationCredit,
    remainingAfterReservation: creditsRemaining,
    rollback: ({ suffix, amount = params.amount, metadata }) => {
      if (rolledBack) {
        return Promise.resolve({
          ok: false,
          error: "already_rolled_back",
        });
      }

      rolledBack = true;

      return refundCredits({
        shopId: params.shopId,
        plan: params.plan,
        amount,
        requestId: `${params.requestId}:${suffix}`,
        metadata: metadata ?? params.metadata,
      });
    },
  };
}
