CREATE TABLE "Plan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "creditLimit" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

INSERT INTO "Plan" ("id", "name", "creditLimit", "createdAt", "updatedAt")
VALUES
  ('plan_free', 'free', 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_basic', 'basic', 2000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_standard', 'standard', 10000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_pro', 'pro', 25000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE
SET "creditLimit" = EXCLUDED."creditLimit",
    "updatedAt" = CURRENT_TIMESTAMP;

CREATE TABLE "CreditUsageLog" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "amount" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditUsageLog_shop_createdAt_idx" ON "CreditUsageLog"("shop", "createdAt");

ALTER TABLE "ShopCredit"
  ADD COLUMN "planId" TEXT,
  ADD COLUMN "cycleStartsAt" TIMESTAMP(3),
  ADD COLUMN "cycleEndsAt" TIMESTAMP(3);

UPDATE "ShopCredit"
SET "plan" = 'standard'
WHERE "plan" = 'advanced';

UPDATE "ShopCredit"
SET "planId" = p."id",
    "cycleStartsAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
    "cycleEndsAt" = "resetDate",
    "creditsLimit" = p."creditLimit"
FROM "Plan" p
WHERE p."name" = "ShopCredit"."plan";

UPDATE "ShopCredit"
SET "planId" = (SELECT "id" FROM "Plan" WHERE "name" = 'free'),
    "cycleStartsAt" = COALESCE("cycleStartsAt", CURRENT_TIMESTAMP),
    "cycleEndsAt" = COALESCE("cycleEndsAt", CURRENT_TIMESTAMP + INTERVAL '1 month'),
    "plan" = 'free',
    "creditsLimit" = 100
WHERE "planId" IS NULL;

ALTER TABLE "ShopCredit"
  ALTER COLUMN "planId" SET NOT NULL,
  ALTER COLUMN "cycleStartsAt" SET NOT NULL,
  ALTER COLUMN "cycleEndsAt" SET NOT NULL,
  ALTER COLUMN "creditsUsed" TYPE INTEGER USING CEIL("creditsUsed")::INTEGER,
  ALTER COLUMN "creditsUsed" SET DEFAULT 0,
  ALTER COLUMN "creditsLimit" TYPE INTEGER USING CEIL("creditsLimit")::INTEGER,
  ALTER COLUMN "creditsLimit" SET DEFAULT 100;

CREATE INDEX "ShopCredit_planId_idx" ON "ShopCredit"("planId");
CREATE INDEX "ShopCredit_cycleEndsAt_idx" ON "ShopCredit"("cycleEndsAt");

ALTER TABLE "ShopCredit"
  ADD CONSTRAINT "ShopCredit_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
