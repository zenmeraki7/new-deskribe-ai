// app/routes/app.templates.tsx
import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../lib/db.server";

// ── Loader: fetch templates for this shop ─────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const templates = await db.customTemplate.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: 20, // show last 20
  });

  return json({ templates });
}

// ── Action: create or delete ───────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // ── Create ──
  if (intent === "create_template") {
    const name = String(fd.get("name") ?? "").trim().slice(0, 80);
    const instruction = String(fd.get("instruction") ?? "").trim().slice(0, 1000);

    if (!name || !instruction) {
      return json({ ok: false, error: "Name and instruction are required" }, { status: 400 });
    }

    // Max 10 templates per shop
    const count = await db.customTemplate.count({ where: { shopDomain } });
    if (count >= 10) {
      return json({ ok: false, error: "Maximum 10 custom templates allowed" }, { status: 400 });
    }

    const template = await db.customTemplate.create({
      data: { shopDomain, name, instruction },
    });

    return json({ ok: true, template });
  }

  // ── Delete ──
  if (intent === "delete_template") {
    const id = String(fd.get("id") ?? "");
    await db.customTemplate.deleteMany({
      where: { id, shopDomain }, // shopDomain check prevents deleting others' templates
    });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}