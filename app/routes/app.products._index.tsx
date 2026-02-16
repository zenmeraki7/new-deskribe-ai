/**
 * Route: /app/products
 * 
 * Products listing page
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Button,
} from "@shopify/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Fetch products from Shopify
  const response = await admin.graphql(
    `#graphql
      query getProducts {
        products(first: 50) {
          edges {
            node {
              id
              title
              status
              totalInventory
            }
          }
        }
      }
    `
  );

  const data = await response.json();
  const products = data.data.products.edges.map((edge: any) => edge.node);

  return { products };
};

export default function ProductsIndex() {
  const { products } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const rowMarkup = products.map((product: any, index: number) => (
<IndexTable.Row
    id={product.id}
    key={product.id}
    position={index}
    onClick={() => {
      // Extract the numeric ID and encode it properly
      const numericId = product.id.split("/").pop();
      if (numericId) {
        navigate(`/app/products/${numericId}`);
      }
    }}
  >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">
          {product.title}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{product.status}</IndexTable.Cell>
      <IndexTable.Cell>{product.totalInventory}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Products">
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              itemCount={products.length}
              headings={[
                { title: "Product" },
                { title: "Status" },
                { title: "Inventory" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}