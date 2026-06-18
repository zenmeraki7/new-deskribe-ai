/*
  Warnings:

  - Added the required column `productTitle` to the `GenerationJob` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "GenerationJob_shopDomain_productId_idx";

-- DropIndex
DROP INDEX "GenerationJob_shopDomain_status_idx";

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "bulkId" TEXT,
ADD COLUMN     "bullJobId" TEXT,
ADD COLUMN     "costTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "productTitle" TEXT NOT NULL,
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "traceId" TEXT;
