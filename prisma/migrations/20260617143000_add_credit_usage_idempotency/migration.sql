ALTER TABLE "CreditUsageLog"
ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "CreditUsageLog_shop_idempotencyKey_key"
ON "CreditUsageLog"("shop", "idempotencyKey");
