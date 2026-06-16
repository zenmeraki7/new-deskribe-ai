import crypto from "node:crypto";

function hashShop(shopDomain: string) {
  return crypto
    .createHash("sha256")
    .update(shopDomain)
    .digest("hex")
    .slice(0, 12);
}

export const logger = {
  info(message: string, data: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ level: "info", message, ...sanitize(data) }));
  },
  error(message: string, data: Record<string, unknown> = {}) {
    console.error(
      JSON.stringify({ level: "error", message, ...sanitize(data) }),
    );
  },
};

function sanitize(data: Record<string, unknown>) {
  const copy = { ...data };

  if (typeof copy.shopDomain === "string") {
    copy.shopHash = hashShop(copy.shopDomain);
    delete copy.shopDomain;
  }

  if (typeof copy.errorMessage === "string") {
    copy.errorMessage = copy.errorMessage.slice(0, 300);
  }

  return copy;
}
