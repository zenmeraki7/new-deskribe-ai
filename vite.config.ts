import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals({ nativeFetch: true });

if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

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

function fixPolarisPrintMediaQuery() {
  return {
    name: "fix-polaris-print-media-query",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("@shopify/polaris") || !id.includes(".css")) {
        return null;
      }

      return code.replaceAll(
        "@media (--p-breakpoints-md-up) and print",
        "@media print",
      );
    },
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
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
    fixPolarisPrintMediaQuery(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.code === "EMPTY_BUNDLE" &&
          warning.message.includes("Generated an empty chunk")
        ) {
          return;
        }

        warn(warning);
      },
    },
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
