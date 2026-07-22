import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  resolve: { alias: { "@": path.resolve(__dirname) } },
  build: {
    ssr: path.resolve(__dirname, "server/boot.ts"),
    outDir: "dist",
    emptyOutDir: false,
    target: "node22",
    rollupOptions: {
      output: { format: "cjs", entryFileNames: "server.js" },
    },
  },
});
