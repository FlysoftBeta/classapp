import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const buildId = process.env.CLASSAPP_BUILD_ID ?? "dev";

export default defineConfig(({ command }) => ({
  // Development serves static resources directly. Production copies public/
  // beside the server bundle in the release build, so it must not be duplicated into
  // the monolithic client build.
  publicDir: command === "serve" ? path.resolve(__dirname, "public") : false,
  plugins: [react()],
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
    outDir: "dist/client",
    emptyOutDir: true,
    target: "chrome70",
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: Infinity,
    rolldownOptions: {
      input: path.resolve(__dirname, "client/main.tsx"),
      output: {
        entryFileNames: "app/app.js",
        chunkFileNames: "app/[name].js",
        assetFileNames: "app/[name][extname]",
        codeSplitting: false,
      },
    },
  },
}));
