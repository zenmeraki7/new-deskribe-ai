// FILE: app/routes/app.tsx

import type {
  HeadersFunction,
  LoaderFunctionArgs,
  LinksFunction,
} from "@remix-run/node";
import { Outlet, Link, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { requireManagedSubscription } from "../lib/billing.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const billingRedirect = await requireManagedSubscription(request);

  if (billingRedirect) {
    return billingRedirect;
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function AppLayout() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/jobs">History</Link>
      </NavMenu>

      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};