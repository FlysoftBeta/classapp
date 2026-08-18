import { defineConfig } from "vite";
import path from "node:path";

const SERVER_BUNDLES = {
  main: { input: "server/main.ts", fileName: "main.mjs" },
  executor: {
    input: "server/runtime/executorWorker.ts",
    fileName: "executor.mjs",
  },
} as const;

const bundleName = process.env.CLASSAPP_SERVER_BUNDLE;
if (bundleName !== "main" && bundleName !== "executor") {
  throw new Error(
    "CLASSAPP_SERVER_BUNDLE must be 'main' or 'executor'. The release script builds each as its own monolithic SSR bundle because Rolldown forbids codeSplitting:false with multiple inputs.",
  );
}
const bundle = SERVER_BUNDLES[bundleName];

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // playwright-core conditionally requires these optional BiDi helpers.
      // Its CommonJS try/catch is flattened by Rollup, so provide a harmless
      // bundled fallback instead of leaving an undeclared runtime import.
      "chromium-bidi/lib/cjs/bidiMapper/BidiMapper": path.resolve(
        __dirname,
        "server/infra/playwrightBidiUnavailable.ts",
      ),
      "chromium-bidi/lib/cjs/cdp/CdpConnection": path.resolve(
        __dirname,
        "server/infra/playwrightBidiUnavailable.ts",
      ),
    },
  },
  ssr: {
    // Keep native addons, ws, and Playwright external. Their self-contained
    // runtime files are assembled by scripts/prepare-runtime-deps.mjs for each
    // release. Playwright's CommonJS dependency graph uses __dirname, which
    // cannot run when Rollup flattens it into this ESM bundle.
    noExternal: true,
    external: ["better-sqlite3", "ws", "playwright"],
  },
  build: {
    // Packaged beside the server bundle for private Incident symbolication.
    sourcemap: "hidden",
    ssr: path.resolve(__dirname, bundle.input),
    outDir: "dist/server",
    emptyOutDir: false,
    target: "node22",
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: Infinity,
    rolldownOptions: {
      output: {
        entryFileNames: bundle.fileName,
        codeSplitting: false,
        minify: true,
      },
    },
  },
});
