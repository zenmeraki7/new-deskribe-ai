ALTER TABLE "GenerationJob"
  ADD COLUMN "creditRequestId" TEXT,
  ADD COLUMN "creditCost" DECIMAL(12, 1);

CREATE TABLE "ShopCredit" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "plan" TEXT NOT NULL DEFAULT 'free',
  "creditsUsed" DECIMAL(12, 1) NOT NULL DEFAULT 0,
  "creditsLimit" DECIMAL(12, 1) NOT NULL,
  "resetDate" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShopCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditTransaction" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(12, 1) NOT NULL,
  "plan" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopCredit_shopId_key" ON "ShopCredit"("shopId");
CREATE INDEX "ShopCredit_shopId_idx" ON "ShopCredit"("shopId");
CREATE INDEX "ShopCredit_resetDate_idx" ON "ShopCredit"("resetDate");

CREATE UNIQUE INDEX "CreditTransaction_shopId_requestId_kind_key"
  ON "CreditTransaction"("shopId", "requestId", "kind");
CREATE INDEX "CreditTransaction_shopId_idx" ON "CreditTransaction"("shopId");
CREATE INDEX "CreditTransaction_requestId_idx" ON "CreditTransaction"("requestId");

CREATE INDEX "GenerationJob_creditRequestId_idx" ON "GenerationJob"("creditRequestId");
