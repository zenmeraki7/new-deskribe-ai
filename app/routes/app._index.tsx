import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

import { requireAdminSession } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminSession(request);
  throw redirect("/app/products");
}

export default function AppIndexRedirect() {
  return null;
}
