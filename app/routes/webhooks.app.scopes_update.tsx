import type { ActionFunctionArgs } from "@remix-run/node";

import { db } from "../lib/db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const currentScopes = Array.isArray(payload.current) ? payload.current : [];

  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: currentScopes.join(",") },
    });
  }

  return new Response(null, { status: 200 });
};
