// FILE: app/routes/app.products.$productId.tsx
/**
 * Route: /app/products/:productId
 *
 * Thin route module:
 * - Re-exports server loader/action from app.products.$productId.server
 * - Re-exports UI from app.products.$productId.ui
 *
 * SECURITY CONTRACT:
 * - All authentication (authenticate.admin), shop scoping, idempotency, and
 *   Shopify API writes MUST live inside app.products.$productId.server.
 * - This file must contain ZERO business logic.
 */

export { loader, action } from "./app.products.$productId.server";
export { default } from "./app.products.$productId.ui";
