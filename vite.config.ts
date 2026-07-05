import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals({ nativeFetch: true });

if (process.env.HOST) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

const allowedHosts = Array.from(
  new Set([host, ".trycloudflare.com"].filter(Boolean)),
);

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts,
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: false,
        v3_routeConfig: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  // ── Fix: prevent Vite bundling Node built-ins for the client ──────────────
  ssr: {
    external: [
      "crypto",
      "stream",
      "buffer",
      "util",
      "http",
      "https",
      "url",
      "zlib",
      "path",
      "fs",
      "os",
      "cookie-signature",
    ],
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react", "@shopify/polaris"],
    exclude: ["crypto", "cookie-signature"],
  },
  // ─────────────────────────────────────────────────────────────────────────
}) satisfies UserConfig;
