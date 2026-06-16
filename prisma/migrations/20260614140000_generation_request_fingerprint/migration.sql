ALTER TABLE "GenerationJob"
ADD COLUMN "requestFingerprint" TEXT;

CREATE INDEX "GenerationJob_shopDomain_requestFingerprint_idx"
ON "GenerationJob"("shopDomain", "requestFingerprint");

CREATE UNIQUE INDEX "GenerationJob_active_request_product_key"
ON "GenerationJob"("shopDomain", "requestFingerprint", "productId")
WHERE "requestFingerprint" IS NOT NULL
  AND "status" IN ('PENDING', 'PROCESSING');
