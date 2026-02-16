// FILE: app/routes/app.jobs.tsx
/**
 * Route: /app/jobs
 *
 * Thin route module:
 * - Re-exports server loader/action from app.jobs.server
 * - Re-exports UI from app.jobs.ui
 *
 * SECURITY CONTRACT:
 * - All authentication, shop scoping, idempotency, and queue interaction
 *   MUST live inside app.jobs.server.
 * - This file must contain ZERO business logic.
 */

export { loader, action } from "./app.jobs.server";
export { default } from "./app.jobs.ui";
