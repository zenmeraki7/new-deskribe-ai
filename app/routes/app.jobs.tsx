// FILE: app/routes/app.jobs.tsx
//
// Route entry point for /app/jobs.
// Delegates loader + action to the server module and UI to the ui module.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  loader as serverLoader,
  action as serverAction,
} from "../features/jobs/app.jobs.server";
import JobsRoute from "./app.jobs.ui";

export async function loader(args: LoaderFunctionArgs) {
  return serverLoader(args);
}

export async function action(args: ActionFunctionArgs) {
  return serverAction(args);
}

export default JobsRoute;