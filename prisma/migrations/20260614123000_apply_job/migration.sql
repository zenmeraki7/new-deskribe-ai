CREATE TABLE "ApplyJob" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplyJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplyJobItem" (
    "id" TEXT NOT NULL,
    "applyJobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplyJobItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApplyJob_shopDomain_jobId_idx" ON "ApplyJob"("shopDomain", "jobId");
CREATE INDEX "ApplyJob_shopDomain_status_idx" ON "ApplyJob"("shopDomain", "status");
CREATE INDEX "ApplyJobItem_productId_status_idx" ON "ApplyJobItem"("productId", "status");
CREATE UNIQUE INDEX "ApplyJobItem_applyJobId_productId_key" ON "ApplyJobItem"("applyJobId", "productId");

ALTER TABLE "ApplyJobItem"
ADD CONSTRAINT "ApplyJobItem_applyJobId_fkey"
FOREIGN KEY ("applyJobId") REFERENCES "ApplyJob"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
