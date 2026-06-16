ALTER TABLE "GenerationJob"
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "lockedBy" VARCHAR(128),
ADD COLUMN "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastErrorCode" TEXT,
ADD COLUMN "lastError" VARCHAR(2000),
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "GenerationJob_status_nextRunAt_idx"
ON "GenerationJob"("status", "nextRunAt");

CREATE INDEX "GenerationJob_shopDomain_status_idx"
ON "GenerationJob"("shopDomain", "status");

CREATE INDEX "GenerationJob_bulkId_status_idx"
ON "GenerationJob"("bulkId", "status");

CREATE INDEX "GenerationJob_shopDomain_bulkId_idx"
ON "GenerationJob"("shopDomain", "bulkId");

CREATE INDEX "GenerationJob_lockedBy_idx"
ON "GenerationJob"("lockedBy");
