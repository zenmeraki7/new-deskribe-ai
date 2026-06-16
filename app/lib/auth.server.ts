import { authenticate } from "../shopify.server";

export type AdminAuthContext = Awaited<ReturnType<typeof authenticate.admin>> & {
  shopDomain: string;
};

export async function requireAdminSession(request: Request): Promise<AdminAuthContext> {
  const context = await authenticate.admin(request);
  const shopDomain = context.session?.shop;

  console.log("[auth] shop resolved:", shopDomain ?? null);

  if (!shopDomain) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return { ...context, shopDomain };
}

export function adminActorLabel(context: AdminAuthContext) {
  const session = context.session as typeof context.session & {
    userId?: bigint | number | string | null;
    email?: string | null;
  };
  const userId = session?.userId;
  if (userId != null) return `shopify-user:${userId.toString()}`;

  const email = session?.email;
  if (email) return `shopify-email:${email}`;

  return `shop:${context.shopDomain}`;
}
