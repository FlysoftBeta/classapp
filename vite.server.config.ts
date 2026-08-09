import { defineConfig } from "vite";
import path from "node:path";

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
    ssr: path.resolve(__dirname, "server/main.ts"),
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: Infinity,
    rolldownOptions: {
      output: { entryFileNames: "main.mjs", codeSplitting: false },
    },
  },
});
