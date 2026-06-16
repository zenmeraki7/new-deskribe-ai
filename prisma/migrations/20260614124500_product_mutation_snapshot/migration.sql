CREATE TABLE "ProductMutationSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "applyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMutationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductMutationSnapshot_shopDomain_jobId_idx" ON "ProductMutationSnapshot"("shopDomain", "jobId");
CREATE INDEX "ProductMutationSnapshot_shopDomain_applyId_idx" ON "ProductMutationSnapshot"("shopDomain", "applyId");
CREATE INDEX "ProductMutationSnapshot_productId_idx" ON "ProductMutationSnapshot"("productId");
