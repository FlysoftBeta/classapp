import assert from "node:assert/strict";
import test from "node:test";
import {
  smokeSeedAvailable,
  startSmokeRuntime,
  type SmokeDataMode,
  type SmokeRuntime,
} from "./harness";
import { smokeAi } from "./suites/ai";
import { smokeAdmin } from "./suites/admin";
import { smokeAnnouncement } from "./suites/announcement";
import { smokeApp } from "./suites/app";
import { smokeArticles } from "./suites/articles";
import { smokeAuth } from "./suites/auth";
import { smokeConversations } from "./suites/conversations";
import { smokeGroups } from "./suites/groups";
import { smokeIncidents } from "./suites/incidents";
import { smokeMedia } from "./suites/media";
import { smokePosts } from "./suites/posts";
import { smokeStickers } from "./suites/stickers";
import { smokeUserConfig } from "./suites/userConfig";
import { smokeWords } from "./suites/words";

const SUITES: Array<{
  name: string;
  run: (runtime: SmokeRuntime) => Promise<void>;
}> = [
  { name: "auth", run: smokeAuth },
  { name: "app", run: smokeApp },
  { name: "groups", run: smokeGroups },
  { name: "conversations", run: smokeConversations },
  { name: "posts", run: smokePosts },
  { name: "articles", run: smokeArticles },
  { name: "stickers", run: smokeStickers },
  { name: "announcement", run: smokeAnnouncement },
  { name: "admin", run: smokeAdmin },
  { name: "incidents", run: smokeIncidents },
  { name: "words", run: smokeWords },
  { name: "media", run: smokeMedia },
  { name: "ai", run: smokeAi },
  { name: "user-config", run: smokeUserConfig },
];

async function runSuites(
  t: test.TestContext,
  runtime: SmokeRuntime,
): Promise<void> {
  assert.ok(runtime.userId);
  assert.ok(runtime.client.hello?.buildId);
  for (const suite of SUITES) {
    await t.test(suite.name, async () => {
      await suite.run(runtime);
    });
  }
}

function requestedModes(): SmokeDataMode[] {
  const selected = process.env.CLASSAPP_SMOKE_DATA ?? "fresh";
  if (selected === "all") return ["fresh", "seeded"];
  if (selected === "seeded" || selected === "fresh") return [selected];
  throw new Error(
    `CLASSAPP_SMOKE_DATA must be fresh, seeded, or all (received ${selected})`,
  );
}

for (const mode of requestedModes()) {
  test(`smoke ${mode} database`, async (t) => {
    if (mode === "seeded" && !smokeSeedAvailable()) {
      t.skip(
        "No seed database; set CLASSAPP_SMOKE_SEED_ROOT or create worktree/data/data.db",
      );
      return;
    }
    const runtime = await startSmokeRuntime(mode);
    t.after(() => runtime.close());
    await runSuites(t, runtime);
  });
}
