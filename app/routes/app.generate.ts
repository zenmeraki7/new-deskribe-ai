// app/routes/generate.ts
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { deepseek } from "../services/deepseek.server";
import { addHistoryEntry } from "../services/history.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, shop } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "generate") {
    try {
      const productId = String(formData.get("productId"));
      const vibe = String(formData.get("vibe") || "edgy");
      const format = String(formData.get("format") || "paragraph");
      const keywords = String(formData.get("keywords") || "");
      const includeSocials = formData.get("includeSocials") === "true";

      // Fetch product details with metafields
      const response = await admin.graphql(
        `#graphql
          query GetProduct($id: ID!) {
            product(id: $id) {
              id
              title
              description
              descriptionHtml
              metafields(first: 50) {
                edges {
                  node {
                    key
                    value
                    namespace
                  }
                }
              }
            }
          }
        `,
        { variables: { id: productId } }
      );

      const data = await response.json();
      const product = data.data?.product;

      if (!product) {
        return json(
          { status: "error", message: "Product not found" },
          { status: 404 }
        );
      }

      // Generate content using DeepSeek AI
      const result = await deepseek.generateDescription({
        product,
        vibe,
        format,
        keywords,
        includeSocials,
        shop,
      });

      // Save to history
      await addHistoryEntry({
        productId: product.id,
        productTitle: product.title,
        description: result.description,
        vibe,
        format,
        keywords,
        includeSocials,
        socials: result.socials || undefined,
      });

      return json({
        status: "success",
        data: {
          description: result.description,
          socials: result.socials,
        },
      });
    } catch (error) {
      console.error("Generation error:", error);
      return json(
        {
          status: "error",
          message: error instanceof Error ? error.message : "Failed to generate content",
        },
        { status: 500 }
      );
    }
  }

  if (actionType === "save") {
    try {
      const productId = String(formData.get("productId"));
      const descriptionHtml = String(formData.get("descriptionHtml"));

      const response = await admin.graphql(
        `#graphql
          mutation UpdateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                descriptionHtml
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            input: {
              id: productId,
              descriptionHtml: descriptionHtml,
            },
          },
        }
      );

      const responseJson = await response.json();
      const userErrors = responseJson.data?.productUpdate?.userErrors ?? [];

      if (userErrors.length > 0) {
        return json(
          {
            status: "error",
            message: userErrors[0].message,
          },
          { status: 400 }
        );
      }

      return json({
        status: "saved",
        message: "Product updated successfully",
      });
    } catch (error) {
      console.error("Save error:", error);
      return json(
        { status: "error", message: "Failed to save product" },
        { status: 500 }
      );
    }
  }

  return json(
    { status: "error", message: "Invalid action" },
    { status: 400 }
  );
}