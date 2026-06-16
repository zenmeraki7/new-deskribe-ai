CREATE TABLE "KeywordSuggestionAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordSuggestionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KeywordSuggestionRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "keywords" TEXT[],
    "creditsDeducted" DECIMAL(12,1) NOT NULL,
    "newBalance" DECIMAL(12,1) NOT NULL,
    "creditBalanceVersion" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordSuggestionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KeywordSuggestionAttempt_shop_createdAt_idx"
ON "KeywordSuggestionAttempt"("shop", "createdAt");

CREATE UNIQUE INDEX "KeywordSuggestionRequest_shop_idempotencyKey_key"
ON "KeywordSuggestionRequest"("shop", "idempotencyKey");

CREATE INDEX "KeywordSuggestionRequest_shop_createdAt_idx"
ON "KeywordSuggestionRequest"("shop", "createdAt");
