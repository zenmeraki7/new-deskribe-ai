ALTER TABLE "ApplyJobItem" ADD COLUMN "applyId" TEXT;
ALTER TABLE "ApplyJobItem" ADD COLUMN "appliedAt" TIMESTAMP(3);

UPDATE "ApplyJobItem"
SET "applyId" = "ApplyJob"."id"
FROM "ApplyJob"
WHERE "ApplyJobItem"."applyJobId" = "ApplyJob"."id";

ALTER TABLE "ApplyJobItem" ALTER COLUMN "applyId" SET NOT NULL;

CREATE UNIQUE INDEX "ApplyJobItem_applyId_productId_key" ON "ApplyJobItem"("applyId", "productId");
