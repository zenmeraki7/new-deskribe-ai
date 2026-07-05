// app/routes/app.templates.tsx
import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { db } from "../lib/db.server";
import { resolvePlan, canUseCustomTemplates } from "../lib/rateLimiter.server";
import { requireAdminSession } from "../lib/auth.server";
import { checkBilling } from "../lib/billing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, shopDomain } = await requireAdminSession(request);

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null); // â† null coalesce

  if (!canUseCustomTemplates(plan)) {
    return json({ forbidden: true, templates: [] }, { status: 403 });
  }

  const templates = await db.customTemplate.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, name: true, instruction: true, createdAt: true },
  });

  return json({
    forbidden: false,
    templates: templates.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(), // â† serialize date
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, shopDomain } = await requireAdminSession(request);

  const { appSubscriptions } = await checkBilling(admin.graphql);
  const plan = resolvePlan(appSubscriptions?.[0]?.name ?? null);

  if (!canUseCustomTemplates(plan)) {
    return json(
      { ok: false, error: "Custom templates require the Advanced or Pro plan." },
      { status: 403 },
    );
  }

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent === "create_template") {
    const name = String(fd.get("name") ?? "").trim().slice(0, 80);
    const instruction = String(fd.get("instruction") ?? "").trim().slice(0, 1000);

    if (!name || !instruction) {
      return json({ ok: false, error: "Name and instruction are required" }, { status: 400 });
    }

    const count = await db.customTemplate.count({ where: { shopDomain } });
    if (count >= 10) {
      return json({ ok: false, error: "Maximum 10 custom templates allowed" }, { status: 400 });
    }

    const template = await db.customTemplate.create({
      data: { shopDomain, name, instruction },
    });

    return json({
      ok: true,
      template: { ...template, createdAt: template.createdAt.toISOString() },
    });
  }

  if (intent === "delete_template") {
    const id = String(fd.get("templateId") ?? "").trim(); // â† consistent key name
    if (!id) {
      return json({ ok: false, error: "Missing templateId" }, { status: 400 });
    }

    await db.customTemplate.deleteMany({ where: { id, shopDomain } });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
}
