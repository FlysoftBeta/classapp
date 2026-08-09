import { X509Certificate, createPublicKey, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import acme from "acme-client";
import { projectRoot, worktreePath } from "../paths.mjs";

const root = projectRoot;
const secretsDir = worktreePath("secrets");
const httpsDir = path.join(secretsDir, "https");
const settingsFile = path.join(secretsDir, "duckdns.json");
const accountKeyFile = path.join(httpsDir, "account-key.pem");
const privateKeyFile = path.join(httpsDir, "privkey.pem");
const fullchainFile = path.join(httpsDir, "fullchain.pem");
const rootCertificateFile = path.join(httpsDir, "root.pem");
const deployConfigFile = path.join(httpsDir, "config.json");
const isrgRootX1Url = "https://letsencrypt.org/certs/isrgrootx1.pem";

function fail(message) {
  throw new Error(message);
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const renew = args.has("--renew");
  if (check === renew) {
    fail("请指定且只指定 --check 或 --renew");
  }
  if (renew && !args.has("--agree-tos")) {
    fail("签发证书前必须显式传入 --agree-tos");
  }
  return {
    check,
    renew,
    force: args.has("--force"),
    staging: args.has("--staging"),
  };
}

function readSettings() {
  if (!fs.existsSync(settingsFile)) {
    fail(`缺少 ${path.relative(root, settingsFile)}`);
  }
  const value = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  for (const field of ["domain", "duckDnsSubdomain", "token"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      fail(`${path.relative(root, settingsFile)} 缺少 ${field}`);
    }
  }
  const domain = value.domain.trim().toLowerCase();
  const expectedSuffix = `${value.duckDnsSubdomain.trim().toLowerCase()}.duckdns.org`;
  if (domain !== expectedSuffix) {
    fail(`domain 必须等于 ${expectedSuffix}`);
  }
  return {
    domain,
    duckDnsSubdomain: value.duckDnsSubdomain.trim().toLowerCase(),
    token: value.token.trim(),
    email:
      typeof value.email === "string" && value.email.trim()
        ? value.email.trim()
        : undefined,
    renewBeforeDays:
      Number.isFinite(value.renewBeforeDays) && value.renewBeforeDays > 0
        ? Math.floor(value.renewBeforeDays)
        : 30,
    preferredChain:
      typeof value.preferredChain === "string" && value.preferredChain.trim()
        ? value.preferredChain.trim()
        : "ISRG Root X1",
  };
}

function samePublicKey(certificate, privateKeyPem) {
  const certificateKey = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const privateKey = createPublicKey(privateKeyPem).export({
    type: "spki",
    format: "der",
  });
  return (
    certificateKey.length === privateKey.length &&
    timingSafeEqual(certificateKey, privateKey)
  );
}

function chainMatchesRoot(fullchainPem, rootCertificate) {
  const blocks =
    fullchainPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  const chain = blocks.map((block) => new X509Certificate(block));
  if (chain.length < 2) return false;
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (!chain[index].verify(chain[index + 1].publicKey)) return false;
  }
  return chain[chain.length - 1].verify(rootCertificate.publicKey);
}

function inspectCertificate(settings) {
  if (
    !fs.existsSync(fullchainFile) ||
    !fs.existsSync(privateKeyFile) ||
    !fs.existsSync(rootCertificateFile)
  ) {
    return {
      present: false,
      valid: false,
      needsRenewal: true,
      reason: "证书、私钥或根证书不存在",
    };
  }
  try {
    const fullchainPem = fs.readFileSync(fullchainFile, "utf8");
    const leaf = new X509Certificate(fullchainPem);
    const rootCertificate = new X509Certificate(
      fs.readFileSync(rootCertificateFile, "utf8"),
    );
    const now = Date.now();
    const notBefore = new Date(leaf.validFrom);
    const notAfter = new Date(leaf.validTo);
    const daysRemaining = Math.floor(
      (notAfter.getTime() - now) / (24 * 60 * 60 * 1000),
    );
    const hostnameValid = leaf.checkHost(settings.domain) !== undefined;
    const keyMatches = samePublicKey(
      leaf,
      fs.readFileSync(privateKeyFile, "utf8"),
    );
    const rootValidFrom = new Date(rootCertificate.validFrom);
    const rootCompatible = rootValidFrom.getUTCFullYear() <= 2020;
    const chainValid = chainMatchesRoot(fullchainPem, rootCertificate);
    const timeValid = notBefore.getTime() <= now && notAfter.getTime() > now;
    const valid =
      hostnameValid && keyMatches && rootCompatible && chainValid && timeValid;
    return {
      present: true,
      valid,
      needsRenewal: !valid || daysRemaining <= settings.renewBeforeDays,
      reason: valid
        ? daysRemaining <= settings.renewBeforeDays
          ? `证书将在 ${daysRemaining} 天后过期`
          : "证书有效"
        : !hostnameValid
          ? "证书域名不匹配"
          : !keyMatches
            ? "证书与私钥不匹配"
            : !rootCompatible
              ? "根 CA 生效日期晚于 2020 年"
              : !chainValid
                ? "网站证书链无法验证到所选根 CA"
                : !timeValid
                  ? "证书不在有效期内"
                  : "证书无效",
      domain: settings.domain,
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      daysRemaining,
      hostnameValid,
      keyMatches,
      rootSubject: rootCertificate.subject,
      rootValidFrom: rootValidFrom.toISOString(),
      rootCompatible,
      chainValid,
    };
  } catch (error) {
    return {
      present: true,
      valid: false,
      needsRenewal: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function duckDnsUpdate(settings, params) {
  const query = new URLSearchParams({
    domains: settings.duckDnsSubdomain,
    token: settings.token,
    ...params,
  });
  const response = await fetch(`https://www.duckdns.org/update?${query}`);
  const body = (await response.text()).trim();
  if (!response.ok || !body.startsWith("OK")) {
    fail(
      `DuckDNS TXT 更新失败（HTTP ${response.status}）: ${body || "空响应"}`,
    );
  }
}

async function waitForTxt(domain, expected) {
  const name = `_acme-challenge.${domain}`;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const values = (await dns.resolveTxt(name)).map((parts) =>
        parts.join(""),
      );
      if (values.includes(expected)) return;
    } catch {
      // DNS propagation is expected to take a little while.
    }
    if (attempt < 30) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  fail(`等待 ${name} TXT 传播超时`);
}

async function readOrCreateAccountKey() {
  if (fs.existsSync(accountKeyFile)) {
    return fs.readFileSync(accountKeyFile);
  }
  const key = await acme.crypto.createPrivateRsaKey(2048);
  fs.mkdirSync(httpsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(accountKeyFile, key, { mode: 0o600 });
  return key;
}

async function downloadCompatibilityRoot() {
  const response = await fetch(isrgRootX1Url);
  if (!response.ok) {
    fail(`下载 ISRG Root X1 失败（HTTP ${response.status}）`);
  }
  const pem = await response.text();
  const certificate = new X509Certificate(pem);
  const validFrom = new Date(certificate.validFrom);
  if (
    !certificate.subject.includes("ISRG Root X1") ||
    validFrom.getUTCFullYear() > 2020
  ) {
    fail("下载到的根证书不是预期的旧版兼容 ISRG Root X1");
  }
  return pem;
}

async function issue(settings, staging) {
  fs.mkdirSync(httpsDir, { recursive: true, mode: 0o700 });
  const accountKey = await readOrCreateAccountKey();
  const [certificateKey, csr] = await acme.crypto.createCsr({
    commonName: settings.domain,
    altNames: [settings.domain],
    keySize: 2048,
  });
  const client = new acme.Client({
    directoryUrl: staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey,
  });
  const certificate = await client.auto({
    csr,
    email: settings.email,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    preferredChain: staging ? undefined : settings.preferredChain,
    skipChallengeVerification: true,
    challengeCreateFn: async (_authorization, challenge, value) => {
      if (challenge.type !== "dns-01") {
        fail(`ACME 返回了不支持的 challenge: ${challenge.type}`);
      }
      console.log("正在写入 DuckDNS TXT challenge…");
      await duckDnsUpdate(settings, { txt: value });
      await waitForTxt(settings.domain, value);
    },
    challengeRemoveFn: async () => {
      console.log("正在清除 DuckDNS TXT challenge…");
      await duckDnsUpdate(settings, { txt: "", clear: "true" });
    },
  });
  const leaf = new X509Certificate(certificate);
  if (
    leaf.checkHost(settings.domain) === undefined ||
    !samePublicKey(leaf, certificateKey)
  ) {
    fail("签发结果的域名或私钥不匹配");
  }
  if (staging) {
    console.log(
      "Let’s Encrypt staging 流程验证成功；测试证书不会写入部署目录。",
    );
    return false;
  }
  const rootCertificate = await downloadCompatibilityRoot();
  if (!chainMatchesRoot(certificate, new X509Certificate(rootCertificate))) {
    fail("签发结果无法验证到 ISRG Root X1");
  }
  fs.writeFileSync(privateKeyFile, certificateKey, { mode: 0o600 });
  fs.writeFileSync(fullchainFile, certificate, { mode: 0o644 });
  fs.writeFileSync(rootCertificateFile, rootCertificate, { mode: 0o644 });
  fs.writeFileSync(
    deployConfigFile,
    `${JSON.stringify(
      {
        domain: settings.domain,
        certificate: "fullchain.pem",
        privateKey: "privkey.pem",
        rootCertificate: "root.pem",
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  return true;
}

async function main() {
  const args = parseArgs();
  const settings = readSettings();
  const before = inspectCertificate(settings);
  console.log(JSON.stringify(before, null, 2));
  if (args.check) {
    process.exitCode = before.needsRenewal ? 2 : 0;
    return;
  }
  if (!args.force && !before.needsRenewal) {
    console.log("证书无需续期。");
    return;
  }
  const installed = await issue(settings, args.staging);
  if (!installed) return;
  const after = inspectCertificate(settings);
  console.log(JSON.stringify(after, null, 2));
  if (!after.valid) fail(after.reason);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
