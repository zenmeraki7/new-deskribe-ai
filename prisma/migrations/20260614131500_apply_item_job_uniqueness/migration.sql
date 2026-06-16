ALTER TABLE "ApplyJobItem" ADD COLUMN "shopDomain" TEXT;
ALTER TABLE "ApplyJobItem" ADD COLUMN "jobId" TEXT;

UPDATE "ApplyJobItem"
SET
  "shopDomain" = "ApplyJob"."shopDomain",
  "jobId" = "ApplyJob"."jobId"
FROM "ApplyJob"
WHERE "ApplyJobItem"."applyJobId" = "ApplyJob"."id";

ALTER TABLE "ApplyJobItem" ALTER COLUMN "shopDomain" SET NOT NULL;
ALTER TABLE "ApplyJobItem" ALTER COLUMN "jobId" SET NOT NULL;

CREATE INDEX "ApplyJobItem_shopDomain_jobId_idx" ON "ApplyJobItem"("shopDomain", "jobId");
CREATE UNIQUE INDEX "ApplyJobItem_active_apply_key"
ON "ApplyJobItem"("shopDomain", "jobId", "productId")
WHERE "status" IN ('QUEUED', 'PROCESSING', 'MUTATING', 'APPLIED', 'UNKNOWN');
