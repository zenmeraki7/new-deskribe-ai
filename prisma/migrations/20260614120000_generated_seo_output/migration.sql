CREATE TABLE "GeneratedSeoOutput" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedSeoOutput_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductSeoSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "applyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductSeoSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeneratedSeoOutput_shopDomain_jobId_idx" ON "GeneratedSeoOutput"("shopDomain", "jobId");
CREATE UNIQUE INDEX "GeneratedSeoOutput_shopDomain_jobId_productId_key" ON "GeneratedSeoOutput"("shopDomain", "jobId", "productId");
CREATE INDEX "ProductSeoSnapshot_shopDomain_jobId_idx" ON "ProductSeoSnapshot"("shopDomain", "jobId");
CREATE UNIQUE INDEX "ProductSeoSnapshot_shopDomain_applyId_productId_key" ON "ProductSeoSnapshot"("shopDomain", "applyId", "productId");
