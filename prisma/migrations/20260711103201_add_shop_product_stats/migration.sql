-- CreateTable
CREATE TABLE "ShopProductStats" (
    "shopDomain" TEXT NOT NULL,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "missingDescriptions" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopProductStats_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateIndex
CREATE INDEX "ShopProductStats_lastSyncedAt_idx" ON "ShopProductStats"("lastSyncedAt");
