//app/lib/auth.server.ts
import { authenticate } from "../shopify.server";

export type AdminAuthContext = Awaited<ReturnType<typeof authenticate.admin>> & {
  shopDomain: string;
};

export async function requireAdminSession(request: Request): Promise<AdminAuthContext> {
  console.log("AUTH A");

  const context = await authenticate.admin(request);

  console.log("AUTH B");

  const shopDomain = context.session?.shop;

  console.log("AUTH C", shopDomain ?? null);

  if (!shopDomain) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return { ...context, shopDomain };
}
