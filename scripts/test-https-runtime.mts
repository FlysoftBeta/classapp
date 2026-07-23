import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setRuntimeConfig } from "../server/infra/runtimeConfig";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "classapp-https-runtime-"),
);
fs.mkdirSync(path.join(tempRoot, "client", "app"), { recursive: true });
fs.mkdirSync(path.join(tempRoot, "public"), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, "shell.html"),
  "<!doctype html><p>shell</p>",
);
fs.writeFileSync(path.join(tempRoot, "client", "app", "app.js"), "export {};");

const config = setRuntimeConfig({
  appDir: tempRoot,
  dataRoot: tempRoot,
  buildId: "https-test-build",
  ports: [8080],
  securePorts: [4443, 4444],
  bindHost: "127.0.0.1",
  nodeEnv: "test",
  initialAdminPin: "123456",
  https: {
    domain: "classapp.duckdns.org",
    certificatePath: path.join(tempRoot, "fullchain.pem"),
    privateKeyPath: path.join(tempRoot, "privkey.pem"),
    rootCertificatePath: path.join(tempRoot, "root.pem"),
  },
  update: {
    enabled: false,
    stagingDir: path.join(tempRoot, "staging"),
    backupDir: path.join(tempRoot, "backup"),
  },
});

const [{ getDb }, { createHttpHandler }, { createHttpsUpgradeService }] =
  await Promise.all([
    import("../server/infra/db"),
    import("../server/http/handler"),
    import("../server/services/httpsUpgradeService"),
  ]);

createHttpsUpgradeService(getDb()).setRedirectEnabled(true);

async function withServer(
  secure: boolean,
  test: (origin: string) => Promise<void>,
) {
  const server = createServer(createHttpHandler(config, { secure }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await withServer(false, async (origin) => {
  const redirected = await fetch(`${origin}/?from=legacy`, {
    redirect: "manual",
  });
  assert.equal(redirected.status, 301);
  assert.equal(
    redirected.headers.get("location"),
    "https://classapp.duckdns.org:4443/?from=legacy",
  );
  assert.equal(
    redirected.headers.get("cache-control"),
    "public, max-age=315360000, immutable",
  );

  const nonShell = await fetch(`${origin}/missing`, { redirect: "manual" });
  assert.equal(nonShell.status, 404);
});

await withServer(true, async (origin) => {
  const shell = await fetch(`${origin}/`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(await shell.text(), /shell/);

  const worker = await fetch(`${origin}/service-worker.js`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get("service-worker-allowed"), "/");
  assert.match(await worker.text(), /classapp-shell-https-test-build/);

  const endpoints = (await (await fetch(`${origin}/api/endpoints`)).json()) as {
    origins: string[];
  };
  assert.deepEqual(endpoints.origins, [
    "https://127.0.0.1:4443",
    "https://127.0.0.1:4444",
  ]);
});

getDb().close();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("HTTPS runtime tests passed");
