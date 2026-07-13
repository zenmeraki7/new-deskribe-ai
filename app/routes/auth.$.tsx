//app/routes/auth.tsx
import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireAdminSession } from "../lib/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);
  return redirect("/app");
};