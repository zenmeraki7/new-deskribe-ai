import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const search = url.searchParams.toString();

  if (url.searchParams.get("shop")) {
    throw redirect(`/app${search ? `?${search}` : ""}`);
  }

  throw redirect("/auth/login");
};

export default function IndexRedirect() {
  return null;
}
