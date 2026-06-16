CREATE TABLE "BulkOperation" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BulkOperation_shopDomain_status_idx"
ON "BulkOperation"("shopDomain", "status");

CREATE INDEX "BulkOperation_createdAt_idx"
ON "BulkOperation"("createdAt");

INSERT INTO "BulkOperation" ("id", "shopDomain", "status", "createdAt", "updatedAt")
SELECT
  "bulkId",
  MIN("shopDomain") AS "shopDomain",
  CASE
    WHEN BOOL_OR("status" IN ('PENDING', 'PROCESSING')) THEN 'ACTIVE'
    WHEN BOOL_AND("status" = 'CANCELLED') THEN 'CANCELLED'
    WHEN BOOL_AND("status" = 'COMPLETED') THEN 'COMPLETED'
    WHEN BOOL_AND("status" = 'FAILED') THEN 'FAILED'
    ELSE 'PARTIAL'
  END AS "status",
  MIN("createdAt") AS "createdAt",
  MAX("updatedAt") AS "updatedAt"
FROM "GenerationJob"
WHERE "bulkId" IS NOT NULL
GROUP BY "bulkId"
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "GeneratedSeoOutput" output
WHERE NOT EXISTS (
  SELECT 1
  FROM "GenerationJob" job
  WHERE job."id" = output."jobId"
);

ALTER TABLE "GeneratedSeoOutput"
ADD COLUMN "appliedAt" TIMESTAMP(3),
ADD COLUMN "appliedBy" VARCHAR(320),
ADD COLUMN "applyId" TEXT;

ALTER TABLE "ApplyJob"
ADD COLUMN "requestedBy" VARCHAR(320);

CREATE INDEX "GeneratedSeoOutput_shopDomain_applyId_idx"
ON "GeneratedSeoOutput"("shopDomain", "applyId");

CREATE INDEX "GeneratedSeoOutput_shopDomain_appliedAt_idx"
ON "GeneratedSeoOutput"("shopDomain", "appliedAt");

ALTER TABLE "GenerationJob"
ADD CONSTRAINT "GenerationJob_bulkId_fkey"
FOREIGN KEY ("bulkId") REFERENCES "BulkOperation"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GeneratedSeoOutput"
ADD CONSTRAINT "GeneratedSeoOutput_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
