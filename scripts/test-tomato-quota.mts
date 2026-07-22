import assert from "node:assert/strict";
import { Client, ClientBusyError, ClientPool } from "@/lib/tomato";
import { DynamicCooldownAllocator } from "@/lib/tomato/quota";
import type { CooldownLayer } from "@/lib/tomato";

class TestClient extends Client {
  constructor() {
    super();
  }

  run<T>(layer: CooldownLayer, operation: () => Promise<T>): Promise<T> {
    return this.throttled(layer, operation);
  }
}

const allocator = new DynamicCooldownAllocator(5_000);
const first = allocator.allocate("user-a", 10_000, 0);
assert.equal(first.retryAt, 10_000);
assert.equal(first.interference, 0);

const contender = allocator.allocate("user-b", 10_000, 0);
assert.equal(contender.retryAt, 15_000, "不同用户不应被分到同一请求窗口");
assert.equal(contender.interference, 0);

const premature = allocator.allocate("user-a", 10_000, 1_000);
assert.equal(premature.interference, 1, "只有提前重试才增加干扰分");
assert.ok(premature.retryAt > contender.retryAt);

allocator.succeeded("user-a");
const afterSuccess = allocator.allocate("user-a", 25_000, 20_000);
assert.equal(afterSuccess.interference, 0, "成功使用次数不能形成惩罚");

const client = new TestClient();
const pool = new ClientPool([{ client, leased: new Set<CooldownLayer>() }]);
assert.equal(client.cooldownMs("search"), 5_000);
assert.equal(client.cooldownMs("download"), 500);

let finishDownload!: () => void;
let markDownloadStarted!: () => void;
const downloadStarted = new Promise<void>((resolve) => {
  markDownloadStarted = resolve;
});
const holdDownload = new Promise<void>((resolve) => {
  finishDownload = resolve;
});
const activeDownload = pool.runQueued("download", (candidate) =>
  candidate.run("download", async () => {
    markDownloadStarted();
    await holdDownload;
  }),
);
await downloadStarted;
await pool.runInteractive("user-a", "search", (candidate) =>
  candidate.run("search", async () => undefined),
);
finishDownload();
await activeDownload;
assert.ok(
  client.availableAt("download") < client.availableAt("search"),
  "搜索与下载应维护独立的租约和冷却窗口",
);
await assert.rejects(
  pool.runInteractive("user-a", "search", (candidate) =>
    candidate.run("search", async () => undefined),
  ),
  ClientBusyError,
  "连续搜索应触发 5 秒冷却",
);

const downloadStartedAt = Date.now();
await pool.runQueued("download", (candidate) =>
  candidate.run("download", async () => undefined),
);
assert.ok(Date.now() - downloadStartedAt >= 400, "连续章节下载应等待约 0.5 秒");

console.log("tomato dynamic cooldown tests passed");
