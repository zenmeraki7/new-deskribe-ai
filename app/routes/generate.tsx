import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { addHistoryEntry } from "../services/history.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "generate") {
    try {
      const productId = String(formData.get("productId"));
      const vibe = String(formData.get("vibe"));
      const format = String(formData.get("format"));
      const keywords = String(formData.get("keywords") || "");
      const includeSocials = formData.get("includeSocials") === "true";

      // Fetch product details
      const response = await admin.graphql(
        `#graphql
          query GetProduct($id: ID!) {
            product(id: $id) {
              id
              title
              description
            }
          }
        `,
        { variables: { id: productId } }
      );

      const data = await response.json();
      const product = data.data?.product;

      if (!product) {
        return json({ status: "error", message: "Product not found" }, { status: 404 });
      }

      // TODO: Replace with actual AI generation
      const generatedDescription = `<p><strong>${vibe} vibes</strong> - This is a ${format} description for ${product.title}. Keywords: ${keywords}</p>`;
      
      const generatedSocials = includeSocials ? {
        twitter: `Check out our amazing ${product.title}! #product #${vibe}`,
        instagram: `✨ Discover ${product.title} - Perfect for your lifestyle! 🌟`
      } : undefined;

      // Save to history
      await addHistoryEntry({
        productId: product.id,
        productTitle: product.title,
        description: generatedDescription,
        vibe,
        format,
        keywords,
        includeSocials,
        socials: generatedSocials,
      });

      return json({
        status: "success",
        data: {
          description: generatedDescription,
          socials: generatedSocials,
        },
      });
    } catch (error) {
      console.error("Generation error:", error);
      return json(
        { status: "error", message: "Failed to generate content" },
        { status: 500 }
      );
    }
  }

  if (actionType === "save") {
    try {
      const productId = String(formData.get("productId"));
      const descriptionHtml = String(formData.get("descriptionHtml"));

      await admin.graphql(
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

      return json({ status: "saved", message: "Product updated successfully" });
    } catch (error) {
      console.error("Save error:", error);
      return json(
        { status: "error", message: "Failed to save product" },
        { status: 500 }
      );
    }
  }

  return json({ status: "error", message: "Invalid action" }, { status: 400 });
}
