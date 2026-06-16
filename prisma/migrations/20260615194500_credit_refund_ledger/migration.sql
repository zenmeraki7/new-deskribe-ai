CREATE TABLE "CreditRefundLedger" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "applyId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditRefundLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditRefundLedger_shopDomain_applyId_jobId_productId_reason_key"
ON "CreditRefundLedger"("shopDomain", "applyId", "jobId", "productId", "reason");
