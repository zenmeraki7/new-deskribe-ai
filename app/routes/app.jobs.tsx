// FILE: app/routes/app.jobs.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

import JobsRoute from "./app.jobs.ui";
import {
  loader as serverLoader,
  action as serverAction,
} from "../features/jobs/app.jobs.server";

export async function loader(args: LoaderFunctionArgs) {
  return serverLoader(args);
}

export async function action(args: ActionFunctionArgs) {
  return serverAction(args);
}

export default JobsRoute;