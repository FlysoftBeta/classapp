import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const server = await createServer({
  root: testDirectory,
  configFile: false,
  logLevel: "error",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 0 },
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Infini2 browser test server did not bind a TCP port");
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  await page.goto(`http://127.0.0.1:${address.port}/browser-fixture.html`);
  await page.waitForFunction(() => window.__infini2Result != null);
  const result = await page.evaluate(() => window.__infini2Result);
  assert.deepEqual(pageErrors, []);
  assert.equal(
    result?.ok,
    true,
    result?.error ?? "browser fixture returned no result",
  );
  console.log("Infini2 browser integration passed", result?.details);
} finally {
  await browser?.close();
  await server.close();
}
