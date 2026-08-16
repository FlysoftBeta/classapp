import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const buildId = process.env.CLASSAPP_BUILD_ID ?? "dev";

// KaTeX is injected into the monolithic client bundle as an inline stylesheet
// so the release Shell does not need to fetch a separate CSS asset. Keep only
// the woff2 sources in the inlined CSS: Chrome 70 supports woff2 and the woff
// and ttf fallbacks would triple the font payload.
function katexWoff2Only(): Plugin {
  return {
    name: "classapp:katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      if (!file.endsWith("node_modules/katex/dist/katex.min.css")) return null;
      const output = code.replace(
        /,\s*url\(fonts\/[^)]*\.woff\)\s*format\(["']woff["']\)|,\s*url\(fonts\/[^)]*\.ttf\)\s*format\(["']truetype["']\)/g,
        "",
      );
      return {
        code: output,
        map: {
          version: 3,
          sources: [],
          sourcesContent: [],
          names: [],
          mappings: "",
        },
      };
    },
  };
}

export default defineConfig(({ command }) => ({
  // Development serves static resources directly. Production copies public/
  // beside the server bundle in the release build, so it must not be duplicated into
  // the monolithic client build.
  publicDir: command === "serve" ? path.resolve(__dirname, "public") : false,
  plugins: [katexWoff2Only(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "@infini-scroll/core": path.resolve(
        __dirname,
        "lib/infini/packages/infini-core/src/index.ts",
      ),
      "@infini-scroll/dom-support": path.resolve(
        __dirname,
        "lib/infini/packages/infini-dom-support/src/index.ts",
      ),
      "@infini-scroll/react": path.resolve(
        __dirname,
        "lib/infini/packages/infini-react/src/index.ts",
      ),
    },
  },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    proxy: {
      // The backend is intentionally loopback-only in development. Preserve
      // the browser's peer address for client identity across this proxy hop.
      "/ws": { target: "ws://127.0.0.1:3001", ws: true, xfwd: true },
      "/api": { target: "http://127.0.0.1:3001", xfwd: true },
      "/app": { target: "http://127.0.0.1:3001", xfwd: true },
    },
  },
  build: {
    // Kept out of the browser-facing artifact by scripts/builds/build.mjs.
    // `hidden` also prevents a sourceMappingURL from being written to app.js.
    sourcemap: "hidden",
    outDir: "dist/client",
    emptyOutDir: false,
    target: "chrome70",
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: Infinity,
    rolldownOptions: {
      input: path.resolve(__dirname, "client/main.tsx"),
      output: {
        entryFileNames: "app.js",
        codeSplitting: false,
        minify: true,
      },
    },
  },
}));
