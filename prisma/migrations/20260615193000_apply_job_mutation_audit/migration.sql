ALTER TABLE "ApplyJob"
ADD COLUMN "cancelledAt" TIMESTAMP(3);

ALTER TABLE "ApplyJobItem"
ADD COLUMN "mutationStartedAt" TIMESTAMP(3),
ADD COLUMN "mutationCompletedAt" TIMESTAMP(3),
ADD COLUMN "mutationAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "mutationFingerprint" TEXT,
ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "retryAfter" TIMESTAMP(3);

ALTER TABLE "GeneratedSeoOutput"
ADD COLUMN "sourceHash" TEXT;

ALTER TABLE "ProductMutationSnapshot"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PLANNED',
ADD COLUMN "errorMessage" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "ApplyJob_id_shopDomain_jobId_key"
ON "ApplyJob"("id", "shopDomain", "jobId");

CREATE UNIQUE INDEX "ApplyJobItem_shopDomain_applyId_jobId_productId_key"
ON "ApplyJobItem"("shopDomain", "applyId", "jobId", "productId");

CREATE INDEX "ApplyJobItem_shopDomain_applyId_jobId_idx"
ON "ApplyJobItem"("shopDomain", "applyId", "jobId");

CREATE INDEX "GeneratedSeoOutput_shopDomain_jobId_productId_status_idx"
ON "GeneratedSeoOutput"("shopDomain", "jobId", "productId", "status");

CREATE INDEX "ProductMutationSnapshot_shopDomain_applyId_jobId_productId_idx"
ON "ProductMutationSnapshot"("shopDomain", "applyId", "jobId", "productId");
