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

CREATE UNIQUE INDEX "WebhookDelivery_webhookId_key"
ON "WebhookDelivery"("webhookId");

CREATE INDEX "WebhookDelivery_shop_topic_idx"
ON "WebhookDelivery"("shop", "topic");

CREATE INDEX "WebhookDelivery_eventAt_idx"
ON "WebhookDelivery"("eventAt");

CREATE TABLE "ShopWebhookState" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "lastEventAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShopWebhookState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopWebhookState_shop_topic_key"
ON "ShopWebhookState"("shop", "topic");

CREATE INDEX "ShopWebhookState_shop_idx"
ON "ShopWebhookState"("shop");
