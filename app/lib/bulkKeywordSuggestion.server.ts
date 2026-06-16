import { json } from "@remix-run/node";
import { Prisma } from "@prisma/client";

import { suggestKeywordsBulk } from "./ai.server";
import { reserveCredits } from "./creditReservation.server";
import { CREDIT_COSTS, PLAN_CREDITS } from "./creditService.server";
import { db } from "./db.server";
import type { Plan } from "./rateLimiter.server";
import {
  adminGraphqlWithRetry,
  type AdminGraphql,
} from "./shopifyGraphql.server";

export type KeywordSuggestionData = {
  productIds: string[];
  idempotencyKey: string;
};

type ProductMeta = {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
};

type ProductNodesResponse = {
  data?: {
    nodes?: Array<{
      __typename?: string;
      id?: string;
      title?: string;
      vendor?: string;
      productType?: string;
      tags?: string[];
    } | null>;
  };
  errors?: Array<{ message?: string }>;
};

export type KeywordCreditState = {
  newBalance: number | null;
  creditBalanceVersion: number | null;
};

export async function getKeywordCreditState({
  shopDomain,
  plan,
}: {
  shopDomain: string;
  plan?: Plan;
}): Promise<KeywordCreditState> {
  try {
    const shopCredit = await db.shopCredit.findUnique({
      where: { shopId: shopDomain },
      select: {
        creditsUsed: true,
        creditsLimit: true,
        resetDate: true,
        updatedAt: true,
      },
    });

    if (!shopCredit) {
      return {
        newBalance: plan ? PLAN_CREDITS[plan] : null,
        creditBalanceVersion: 0,
      };
    }

    const limit =
      shopCredit.resetDate <= new Date() && plan
        ? PLAN_CREDITS[plan]
        : shopCredit.creditsLimit.toNumber();
    const used =
      shopCredit.resetDate <= new Date()
        ? 0
        : shopCredit.creditsUsed.toNumber();

    return {
      newBalance: Math.max(0, limit - used),
      creditBalanceVersion: shopCredit.updatedAt.getTime(),
    };
  } catch (error) {
    console.warn("[keyword-suggest] credit state unavailable:", error);
    return { newBalance: null, creditBalanceVersion: null };
  }
}

async function productAccessDeniedResponse(shopDomain: string, plan: Plan) {
  const creditState = await getKeywordCreditState({ shopDomain, plan });
  return json(
    {
      ok: false,
      code: "PRODUCT_ACCESS_DENIED",
      error:
        "One or more selected products are unavailable or do not belong to this shop.",
      ...creditState,
    },
    { status: 403 },
  );
}

async function productVerificationUnavailableResponse(
  shopDomain: string,
  plan: Plan,
) {
  const creditState = await getKeywordCreditState({ shopDomain, plan });
  return json(
    {
      ok: false,
      code: "PRODUCT_VERIFICATION_UNAVAILABLE",
      error: "Could not verify the selected products. Please try again.",
      ...creditState,
    },
    { status: 502 },
  );
}

async function writeReplay(
  shopDomain: string,
  idempotencyKey: string,
  result: {
    keywords: string[];
    creditsDeducted: number;
    newBalance: number;
    creditBalanceVersion?: number;
  },
) {
  const creditBalanceVersion = result.creditBalanceVersion ?? Date.now();

  await db.keywordSuggestionRequest.upsert({
    where: {
      shop_idempotencyKey: {
        shop: shopDomain,
        idempotencyKey,
      },
    },
    create: {
      shop: shopDomain,
      idempotencyKey,
      keywords: result.keywords,
      creditsDeducted: new Prisma.Decimal(result.creditsDeducted),
      newBalance: new Prisma.Decimal(result.newBalance),
      creditBalanceVersion: BigInt(creditBalanceVersion),
    },
    update: {},
  });
}

export async function getKeywordSuggestionReplay({
  shopDomain,
  idempotencyKey,
}: {
  shopDomain: string;
  idempotencyKey: string;
}) {
  const existing = await db.keywordSuggestionRequest.findUnique({
    where: {
      shop_idempotencyKey: {
        shop: shopDomain,
        idempotencyKey,
      },
    },
  });

  if (!existing) return null;

  return {
    keywords: existing.keywords,
    creditsDeducted: existing.creditsDeducted.toNumber(),
    newBalance: existing.newBalance.toNumber(),
    creditBalanceVersion: Number(existing.creditBalanceVersion),
  };
}

async function verifyOwnedProducts(
  adminGraphql: AdminGraphql,
  productIds: string[],
  shopDomain: string,
  plan: Plan,
): Promise<
  { ok: true; productMetas: ProductMeta[] } | { ok: false; response: Response }
> {
  const uniqueProductIds = [...new Set(productIds)];
  let gql: ProductNodesResponse;

  try {
    gql = await adminGraphqlWithRetry<ProductNodesResponse>(
      adminGraphql,
      `#graphql
      query ProductNodesMeta($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Product {
            id
            title
            vendor
            productType
            tags
          }
        }
      }`,
      { ids: uniqueProductIds },
    );
  } catch (error) {
    console.error("[keyword-suggest] product verification failed:", error);
    return {
      ok: false,
      response: await productVerificationUnavailableResponse(shopDomain, plan),
    };
  }

  if (Array.isArray(gql.errors) && gql.errors.length > 0) {
    console.error("[keyword-suggest] product verification GraphQL errors", {
      errorCount: gql.errors.length,
    });
    return {
      ok: false,
      response: await productVerificationUnavailableResponse(shopDomain, plan),
    };
  }

  const nodes = gql.data?.nodes;
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      response: await productVerificationUnavailableResponse(shopDomain, plan),
    };
  }

  if (nodes.length !== uniqueProductIds.length) {
    return {
      ok: false,
      response: await productAccessDeniedResponse(shopDomain, plan),
    };
  }

  const requestedIds = new Set(uniqueProductIds);
  const returnedIds = new Set<string>();
  const productsById = new Map<string, ProductMeta>();

  for (const node of nodes) {
    const id = node?.id;
    if (
      node?.__typename !== "Product" ||
      typeof id !== "string" ||
      !requestedIds.has(id) ||
      returnedIds.has(id) ||
      typeof node.title !== "string"
    ) {
      return {
        ok: false,
        response: await productAccessDeniedResponse(shopDomain, plan),
      };
    }

    returnedIds.add(id);
    productsById.set(id, {
      title: node.title,
      vendor: typeof node.vendor === "string" ? node.vendor : "",
      productType: typeof node.productType === "string" ? node.productType : "",
      tags: Array.isArray(node.tags)
        ? node.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
    });
  }

  if (
    returnedIds.size !== requestedIds.size ||
    uniqueProductIds.some((id) => !returnedIds.has(id))
  ) {
    return {
      ok: false,
      response: await productAccessDeniedResponse(shopDomain, plan),
    };
  }

  return {
    ok: true,
    productMetas: uniqueProductIds.map((id) => productsById.get(id)!),
  };
}

export async function bulkKeywordAction({
  data,
  shopDomain,
  adminGraphql,
  plan,
}: {
  data: KeywordSuggestionData;
  shopDomain: string;
  adminGraphql: AdminGraphql;
  plan: Plan;
}) {
  const { productIds, idempotencyKey } = data;
  const replay = await getKeywordSuggestionReplay({
    shopDomain,
    idempotencyKey,
  });

  if (replay) {
    return json({
      ok: true,
      ...replay,
      idempotentReplay: true,
    });
  }

  const verification = await verifyOwnedProducts(
    adminGraphql,
    productIds,
    shopDomain,
    plan,
  );
  if (!verification.ok) return verification.response;

  const reservation = await reserveCredits({
    shopId: shopDomain,
    plan,
    amount: CREDIT_COSTS.keywordSuggestion,
    requestId: idempotencyKey,
    kind: "keyword_suggestion",
    metadata: {
      operation: "suggest_keywords_bulk",
      productCount: productIds.length,
    },
  });

  if (!reservation.allowed) {
    return json(
      {
        ok: false,
        code: "INSUFFICIENT_CREDITS",
        error: "Not enough credits",
        creditsRemaining: reservation.creditsRemaining,
        newBalance: reservation.creditsRemaining,
        creditBalanceVersion: (
          await getKeywordCreditState({ shopDomain, plan })
        ).creditBalanceVersion,
        creditsLimit: reservation.creditsLimit,
        resetDate: reservation.resetDate.toISOString(),
        plan,
      },
      { status: 402 },
    );
  }

  try {
    const keywords = await suggestKeywordsBulk(verification.productMetas);
    const safe = keywords
      .filter((keyword) => typeof keyword === "string" && keyword.trim())
      .map((keyword) => keyword.trim().slice(0, 50))
      .slice(0, 20);

    const creditState = await getKeywordCreditState({ shopDomain, plan });
    const creditBalanceVersion = creditState.creditBalanceVersion ?? Date.now();
    const result = {
      keywords: safe,
      creditsDeducted: reservation.alreadyApplied
        ? 0
        : CREDIT_COSTS.keywordSuggestion,
      newBalance: reservation.remainingAfterReservation,
      creditBalanceVersion,
    };
    await writeReplay(shopDomain, idempotencyKey, result);

    return json({
      ok: true,
      kind: "suggest_keywords_bulk",
      ...result,
      idempotentReplay: reservation.alreadyApplied === true,
    });
  } catch (error) {
    if (!reservation.alreadyApplied) {
      await reservation.rollback({
        suffix: "failed",
        metadata: {
          operation: "suggest_keywords_bulk",
          productCount: productIds.length,
        },
      });
    }

    const creditState = await getKeywordCreditState({ shopDomain, plan });
    const message =
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.message
        : "Could not suggest keywords. Please try again.";
    return json(
      {
        ok: false,
        error: message,
        code: "SUGGEST_BULK_FAILED",
        ...creditState,
      },
      { status: 500 },
    );
  }
}
