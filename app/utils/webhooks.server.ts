import crypto from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../lib/db.server";
import { appLog } from "./observability.server";

export function webhookIdFromRequest(request: Request) {
  return (
    request.headers.get("x-shopify-webhook-id") ??
    request.headers.get("X-Shopify-Webhook-Id") ??
    null
  );
}

export function webhookEventAtFromRequest(request: Request, payload?: unknown) {
  const headerValue =
    request.headers.get("x-shopify-triggered-at") ??
    request.headers.get("X-Shopify-Triggered-At");
  const payloadValue =
    payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).updated_at ??
          (payload as Record<string, unknown>).created_at)
      : null;
  const raw = typeof headerValue === "string" ? headerValue : payloadValue;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stableWebhookId(shop: string, topic: string, payload: unknown) {
  return crypto
    .createHash("sha256")
    .update(`${shop}:${topic}:${JSON.stringify(payload ?? {})}`)
    .digest("hex");
}

export async function recordWebhookDelivery({
  request,
  shop,
  topic,
  payload,
  eventAt,
}: {
  request: Request;
  shop: string;
  topic: string;
  payload?: unknown;
  eventAt?: Date | null;
}) {
  const webhookId =
    webhookIdFromRequest(request) ?? stableWebhookId(shop, topic, payload);
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload ?? {}))
    .digest("hex");

  try {
    await db.webhookDelivery.create({
      data: {
        webhookId,
        shop,
        topic,
        eventAt: eventAt ?? null,
        payloadHash,
      },
    });
    appLog.info("Webhook delivery recorded", {
      operation: "webhook.delivery",
      shop,
      requestId: webhookId,
      status: "received",
      topic,
      eventAt: eventAt?.toISOString() ?? null,
    });
    return { duplicate: false, webhookId };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.webhookDelivery.findUnique({
        where: { webhookId },
        select: { status: true },
      });
      appLog.info("Webhook duplicate delivery received", {
        operation: "webhook.delivery",
        shop,
        requestId: webhookId,
        status: existing?.status === "PROCESSED" ? "duplicate_processed" : "retry_pending",
        topic,
        eventAt: eventAt?.toISOString() ?? null,
      });
      return { duplicate: existing?.status === "PROCESSED", webhookId };
    }
    throw error;
  }
}

export async function markWebhookProcessed(webhookId: string) {
  await db.webhookDelivery.updateMany({
    where: { webhookId },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
  appLog.info("Webhook delivery processed", {
    operation: "webhook.delivery",
    requestId: webhookId,
    status: "processed",
  });
}

export async function shouldProcessWebhookEvent({
  shop,
  topic,
  eventAt,
}: {
  shop: string;
  topic: string;
  eventAt?: Date | null;
}) {
  if (!eventAt) return true;

  return db.$transaction(async (tx) => {
    const existing = await tx.shopWebhookState.findUnique({
      where: { shop_topic: { shop, topic } },
    });

    if (existing && existing.lastEventAt > eventAt) {
      appLog.warn("Webhook event ignored because a newer event was already processed", {
        operation: "webhook.ordering",
        shop,
        requestId: null,
        status: "older_event_ignored",
        topic,
        eventAt: eventAt.toISOString(),
        lastEventAt: existing.lastEventAt.toISOString(),
      });
      return false;
    }

    await tx.shopWebhookState.upsert({
      where: { shop_topic: { shop, topic } },
      create: { shop, topic, lastEventAt: eventAt },
      update: { lastEventAt: eventAt },
    });

    return true;
  });
}
