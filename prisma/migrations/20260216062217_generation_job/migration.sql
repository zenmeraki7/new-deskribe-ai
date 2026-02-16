-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "vibe" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "includeSocials" BOOLEAN NOT NULL,
    "result" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_shopDomain_idx" ON "GenerationJob"("shopDomain");

-- CreateIndex
CREATE INDEX "GenerationJob_productId_idx" ON "GenerationJob"("productId");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE INDEX "GenerationJob_shopDomain_productId_idx" ON "GenerationJob"("shopDomain", "productId");

-- CreateIndex
CREATE INDEX "GenerationJob_shopDomain_status_idx" ON "GenerationJob"("shopDomain", "status");
