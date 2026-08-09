import fs from "node:fs";
import os from "node:os";
import type BetterSqlite3 from "better-sqlite3";
import { X509Certificate } from "node:crypto";
import {
  getHttpsRedirectEnabled,
  setHttpsRedirectEnabled,
} from "@/server/data/appState";
import { getRuntimeConfig } from "@/server/infra/runtimeConfig";

export interface HttpsCertificateStatus {
  present: boolean;
  valid: boolean;
  hostname_valid: boolean;
  not_before: string | null;
  not_after: string | null;
  days_remaining: number | null;
  root_subject: string | null;
  root_valid_from: string | null;
  root_compatible: boolean | null;
  error: string | null;
}

export interface HttpsUpgradeStatus {
  configured: boolean;
  domain: string | null;
  secure_ports: number[];
  redirect_enabled: boolean;
  dns_records: { type: "A" | "AAAA"; name: string; value: string }[];
  certificate: HttpsCertificateStatus;
}

function emptyCertificate(error: string | null = null): HttpsCertificateStatus {
  return {
    present: false,
    valid: false,
    hostname_valid: false,
    not_before: null,
    not_after: null,
    days_remaining: null,
    root_subject: null,
    root_valid_from: null,
    root_compatible: null,
    error,
  };
}

function chainMatchesRoot(
  fullchainPem: string,
  root: X509Certificate,
): boolean {
  const blocks =
    fullchainPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  const chain = blocks.map((block) => new X509Certificate(block));
  if (chain.length < 2) return false;
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (!chain[index].verify(chain[index + 1].publicKey)) return false;
  }
  return chain[chain.length - 1].verify(root.publicKey);
}

function certificateStatus(): HttpsCertificateStatus {
  const { https } = getRuntimeConfig();
  if (!https || !fs.existsSync(https.certificatePath)) {
    return emptyCertificate("未找到网站证书");
  }
  try {
    const fullchainPem = fs.readFileSync(https.certificatePath, "utf8");
    const leaf = new X509Certificate(fullchainPem);
    const now = Date.now();
    const notBefore = new Date(leaf.validFrom);
    const notAfter = new Date(leaf.validTo);
    const hostnameValid = leaf.checkHost(https.domain) !== undefined;
    let root: X509Certificate | null = null;
    if (fs.existsSync(https.rootCertificatePath)) {
      root = new X509Certificate(
        fs.readFileSync(https.rootCertificatePath, "utf8"),
      );
    }
    const rootValidFrom = root ? new Date(root.validFrom) : null;
    const rootCompatible = rootValidFrom
      ? rootValidFrom.getUTCFullYear() <= 2020
      : null;
    const chainValid = root ? chainMatchesRoot(fullchainPem, root) : false;
    const valid =
      notBefore.getTime() <= now &&
      notAfter.getTime() > now &&
      hostnameValid &&
      chainValid &&
      rootCompatible === true;
    return {
      present: true,
      valid,
      hostname_valid: hostnameValid,
      not_before: notBefore.toISOString(),
      not_after: notAfter.toISOString(),
      days_remaining: Math.floor(
        (notAfter.getTime() - now) / (24 * 60 * 60 * 1000),
      ),
      root_subject: root?.subject ?? null,
      root_valid_from: rootValidFrom?.toISOString() ?? null,
      root_compatible: rootCompatible,
      error: valid
        ? null
        : !hostnameValid
          ? "证书域名与预期域名不匹配"
          : rootCompatible === false
            ? "根 CA 的生效日期晚于 2020 年，不满足旧客户端兼容要求"
            : rootCompatible === null
              ? "缺少用于兼容性检查的根 CA 证书"
              : !chainValid
                ? "网站证书链无法验证到所选根 CA"
                : now < notBefore.getTime()
                  ? "证书尚未生效"
                  : now >= notAfter.getTime()
                    ? "证书已过期"
                    : null,
    };
  } catch (error: unknown) {
    return emptyCertificate(
      error instanceof Error ? error.message : "证书无法解析",
    );
  }
}

function localDnsRecords(
  domain: string | null,
): HttpsUpgradeStatus["dns_records"] {
  if (!domain) return [];
  const records: HttpsUpgradeStatus["dns_records"] = [];
  const seen = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal || seen.has(entry.address)) continue;
      if (
        entry.family === "IPv6" &&
        entry.address.toLowerCase().startsWith("fe80:")
      )
        continue;
      seen.add(entry.address);
      records.push({
        type: entry.family === "IPv6" ? "AAAA" : "A",
        name: domain,
        value: entry.address,
      });
    }
  }
  return records;
}

export class HttpsUpgradeService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  isRedirectEnabled(): boolean {
    return (
      getRuntimeConfig().https?.redirectOverride ??
      getHttpsRedirectEnabled(this.db)
    );
  }

  setRedirectEnabled(enabled: boolean): void {
    setHttpsRedirectEnabled(this.db, enabled);
  }

  getStatus(): HttpsUpgradeStatus {
    const runtime = getRuntimeConfig();
    return {
      configured: runtime.https !== null && runtime.securePorts.length > 0,
      domain: runtime.https?.domain ?? null,
      secure_ports: runtime.securePorts,
      redirect_enabled: this.isRedirectEnabled(),
      dns_records: localDnsRecords(runtime.https?.domain ?? null),
      certificate: certificateStatus(),
    };
  }
}

export function createHttpsUpgradeService(
  db: BetterSqlite3.Database,
): HttpsUpgradeService {
  return new HttpsUpgradeService(db);
}
