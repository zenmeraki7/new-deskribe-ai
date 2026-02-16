// // app/routes/generate.ts
// import { json, type ActionFunctionArgs } from "@remix-run/node";
// import { authenticate } from "../shopify.server";
// import { deepseek } from "../services/deepseek.server";
// import { addHistoryEntry } from "../services/history.server";

// // -----------------------------
// // Utility: Safe HTML Sanitizer
// // -----------------------------
// function sanitizeHtml(html: string) {
//   return html
//     .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
//     .replace(/on\w+="[^"]*"/gi, "")
//     .replace(/javascript:/gi, "");
// }

// // -----------------------------
// // Utility: Sleep (rate limit control)
// // -----------------------------
// function sleep(ms: number) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// // -----------------------------
// // Fetch Product Helper
// // -----------------------------
// async function fetchProduct(admin: any, productId: string) {
//   const response = await admin.graphql(
//     `#graphql
//       query GetProduct($id: ID!) {
//         product(id: $id) {
//           id
//           title
//           description
//           descriptionHtml
//           productType
//           vendor
//           tags
//           metafields(first: 50) {
//             edges {
//               node {
//                 key
//                 value
//                 namespace
//               }
//             }
//           }
//         }
//       }
//     `,
//     { variables: { id: productId } }
//   );

//   const data = await response.json();
//   return data.data?.product;
// }

// // -----------------------------
// // Update Product Helper
// // -----------------------------
// async function updateProduct(admin: any, productId: string, descriptionHtml: string) {
//   const response = await admin.graphql(
//     `#graphql
//       mutation UpdateProduct($input: ProductInput!) {
//         productUpdate(input: $input) {
//           product { id }
//           userErrors {
//             field
//             message
//           }
//         }
//       }
//     `,
//     {
//       variables: {
//         input: {
//           id: productId,
//           descriptionHtml,
//         },
//       },
//     }
//   );

//   const data = await response.json();
//   const errors = data.data?.productUpdate?.userErrors ?? [];

//   if (errors.length > 0) {
//     throw new Error(errors[0].message);
//   }

//   return true;
// }

// // =============================
// // ACTION
// // =============================
// export async function action({ request }: ActionFunctionArgs) {
//   const { admin, shop } = await authenticate.admin(request);
//   const formData = await request.formData();
//   const actionType = String(formData.get("actionType") || "");


//   try {
//     // ==================================================
//     // 1️⃣ Suggest Keywords
//     // ==================================================
//     if (actionType === "suggestKeywords") {
//       const productId = formData.get("productId");
// if (!productId || typeof productId !== "string") {
//   return json({ status: "error", message: "Missing productId" }, { status: 400 });
// }

//       const vibe = String(formData.get("vibe") || "edgy");

//       const product = await fetchProduct(admin, productId);
//       if (!product) {
//         return json({ status: "error", message: "Product not found" }, { status: 404 });
//       }

//       const keywords = await deepseek.generateSEOKeywords({
//         product: {
//           title: product.title,
//           description: product.description || "",
//         },
//         vibe,
//       });

//       return json({
//         status: "suggested",
//         keywords: keywords,
//       });
//     }

//     // ==================================================
//     // 2️⃣ Single Generate
//     // ==================================================
//     if (actionType === "generate") {
//       const productId = formData.get("productId");
// if (!productId || typeof productId !== "string") {
//   return json({ status: "error", message: "Missing productId" }, { status: 400 });
// }

//       const vibe = String(formData.get("vibe") || "casual");
//       const format = String(formData.get("format") || "paragraph");
//       const keywords = String(formData.get("keywords") || "");
//       const includeSocials = formData.get("includeSocials") === "true";

//       const product = await fetchProduct(admin, productId);
//       if (!product) {
//         return json({ status: "error", message: "Product not found" }, { status: 404 });
//       }

//       const result = await deepseek.generateDescription({
//         product: {
//           title: product.title,
//           description: product.description || "",
//           productType: product.productType || "",
//           vendor: product.vendor || "",
//           tags: product.tags || [],
//           metafields: product.metafields?.edges || [],

//         },
//         vibe,
//         format,
//         keywords,
//         includeSocials,
//         shop,
//       });

//       const safeHtml = sanitizeHtml(result.description);

//       await addHistoryEntry({
//         productId: product.id,
//         productTitle: product.title,
//         description: safeHtml,
//         vibe,
//         format,
//         keywords,
//         includeSocials,
//         socials: result.socials || undefined,
//       });

//       return json({
//         status: "success",
//         data: {
//           description: safeHtml,
//           socials: result.socials,
//         },
//       });
//     }

//     // ==================================================
//     // 3️⃣ Save Only
//     // ==================================================
//     if (actionType === "save") {
//       const productId = formData.get("productId");
// if (!productId || typeof productId !== "string") {
//   return json({ status: "error", message: "Missing productId" }, { status: 400 });
// }
//       const descriptionHtml = sanitizeHtml(String(formData.get("descriptionHtml")));

//       await updateProduct(admin, productId, descriptionHtml);

//       return json({
//         status: "saved",
//         message: "Product updated successfully",
//       });
//     }

//     // ==================================================
//     // 4️⃣ TRUE Bulk Generate (Server-Side Loop)
//     // ==================================================
//     if (actionType === "bulkGenerate") {
//       let productIds: string[] = [];
// try {
//   productIds = JSON.parse(String(formData.get("productIds") || "[]"));
//   if (!Array.isArray(productIds)) throw new Error();
// } catch {
//   return json({ status: "error", message: "Invalid productIds" }, { status: 400 });
// }
//       const vibe = String(formData.get("vibe") || "casual");
//       const format = String(formData.get("format") || "paragraph");
//       const keywords = String(formData.get("keywords") || "");
//       const includeSocials = formData.get("includeSocials") === "true";

//       let success = 0;
//       let failed = 0;
//       const results = [];

//       for (const productId of productIds) {
//         try {
//           const product = await fetchProduct(admin, productId);
//           if (!product) {
//             failed++;
//             results.push({ productId, status: "failed", reason: "Product not found" });
//             continue;
//           }

//           const result = await deepseek.generateDescription({
//             product: {
//               title: product.title,
//               description: product.description || "",
//               productType: product.productType || "",
//               vendor: product.vendor || "",
//               tags: product.tags || [],
//               metafields: product.metafields?.edges || [],

//             },
//             vibe,
//             format,
//             keywords,
//             includeSocials,
//             shop,
//           });

//           const safeHtml = sanitizeHtml(result.description);

//           await updateProduct(admin, productId, safeHtml);

//           await addHistoryEntry({
//             productId: product.id,
//             productTitle: product.title,
//             description: safeHtml,
//             vibe,
//             format,
//             keywords,
//             includeSocials,
//           });

//           success++;
//           results.push({ productId, status: "success", title: product.title });

//           // Rate limit safety
//           await sleep(500);
//         } catch (err) {
//           console.error("Bulk item failed:", err);
//           failed++;
//           results.push({ 
//             productId, 
//             status: "failed", 
//             reason: err instanceof Error ? err.message : "Unknown error" 
//           });
//         }
//       }

//       return json({
//         status: "bulk_complete",
//         success,
//         failed,
//         total: productIds.length,
//         results,
//       });
//     }

//     return json({ status: "error", message: "Invalid action" }, { status: 400 });

//   } catch (error) {
//     console.error("Action error:", error);

//     return json(
//       {
//         status: "error",
//         message: error instanceof Error ? error.message : "Something went wrong",
//       },
//       { status: 500 }
//     );
//   }
// }