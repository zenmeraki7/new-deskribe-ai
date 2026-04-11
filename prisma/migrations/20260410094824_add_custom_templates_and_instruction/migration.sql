-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "customInstruction" TEXT;

-- CreateTable
CREATE TABLE "CustomTemplate" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomTemplate_shopDomain_idx" ON "CustomTemplate"("shopDomain");
