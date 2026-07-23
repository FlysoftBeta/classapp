import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  resolve: { alias: { "@": path.resolve(__dirname) } },
  build: {
    ssr: path.resolve(__dirname, "launcher/launcher.ts"),
    outDir: "dist",
    emptyOutDir: false,
    target: "node22",
    rolldownOptions: {
      output: { format: "cjs", entryFileNames: "launcher.js" },
    },
  },
});
