// FILE: app/routes/app.products.$productId.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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