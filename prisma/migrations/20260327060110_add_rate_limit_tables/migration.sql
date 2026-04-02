-- CreateTable
CREATE TABLE "ShopUsage" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalUsage" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopUsage_shopDomain_idx" ON "ShopUsage"("shopDomain");

-- CreateIndex
CREATE INDEX "ShopUsage_date_idx" ON "ShopUsage"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ShopUsage_shopDomain_date_key" ON "ShopUsage"("shopDomain", "date");

-- CreateIndex
CREATE INDEX "GlobalUsage_date_idx" ON "GlobalUsage"("date");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalUsage_date_key" ON "GlobalUsage"("date");
