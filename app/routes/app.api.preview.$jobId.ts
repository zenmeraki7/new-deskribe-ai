import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { db } from "../lib/db.server";
import { requireAdminSession } from "../lib/auth.server";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { shopDomain } = await requireAdminSession(request);
  const jobId = params.jobId;

  if (!jobId || !UUID_V4_RE.test(jobId)) {
    return json({ ok: false, error: "Invalid jobId" }, { status: 400 });
  }

  const outputs = await db.generatedSeoOutput.findMany({
    where: {
      shopDomain,
      jobId,
      status: "READY",
    },
    select: {
      id: true,
      jobId: true,
      productId: true,
      fields: true,
      warnings: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return json({
    outputs: outputs.map((output) => ({
      ...output,
      createdAt: output.createdAt.toISOString(),
      updatedAt: output.updatedAt.toISOString(),
    })),
  });
}
