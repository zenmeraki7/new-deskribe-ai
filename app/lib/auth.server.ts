//app/lib/auth.server.ts
import { authenticate } from "../shopify.server";

export type AdminAuthContext = Awaited<ReturnType<typeof authenticate.admin>> & {
  shopDomain: string;
};

export async function requireAdminSession(request: Request): Promise<AdminAuthContext> {
  const context = await authenticate.admin(request);

  const shopDomain = context.session?.shop;

  if (!shopDomain) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return { ...context, shopDomain };
}
