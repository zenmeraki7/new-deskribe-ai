-- CreateTable
CREATE TABLE "CreditUsageLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,

    CONSTRAINT "CreditUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creditLimit" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopWebhookState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopWebhookState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3),
    "payloadHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditUsageLog_shop_createdAt_idx" ON "CreditUsageLog"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditUsageLog_shop_idempotencyKey_key" ON "CreditUsageLog"("shop", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE INDEX "ShopWebhookState_shop_idx" ON "ShopWebhookState"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopWebhookState_shop_topic_key" ON "ShopWebhookState"("shop", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_key" ON "WebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_eventAt_idx" ON "WebhookDelivery"("eventAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_shop_topic_idx" ON "WebhookDelivery"("shop", "topic");
