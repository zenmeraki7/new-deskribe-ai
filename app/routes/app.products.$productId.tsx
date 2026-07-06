// FILE: app/routes/app.products.$productId.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { Banner, BlockStack, Button, Layout, Page, Text } from "@shopify/polaris";
import ProductEditorModalRoute from "./app.products.$productId.ui";
import {
  loader as serverLoader,
  action as serverAction,
} from "../features/products/product-editor.server";

export async function loader(args: LoaderFunctionArgs) {
  return serverLoader(args);
}

export async function action(args: ActionFunctionArgs) {
  return serverAction(args);
}

export default ProductEditorModalRoute;

export function ErrorBoundary() {
  const error = useRouteError();

  const message = isRouteErrorResponse(error)
    ? error.data || `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "The product editor could not be loaded.";

  return (
    <Page title="Product editor">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="critical" title="Could not open product">
              <Text as="p">{String(message)}</Text>
            </Banner>
            <Button url="/app/products">Back to products</Button>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
