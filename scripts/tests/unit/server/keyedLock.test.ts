import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedLock } from "@/server/storage/keyedLock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("the same key is exclusive; a later waiter starts only after the earlier run finishes", async () => {
  const locks = createKeyedLock();
  let inside = false;
  const firstEntered = deferred();
  const firstHold = deferred();

  const first = locks.run("a", async () => {
    inside = true;
    firstEntered.resolve();
    await firstHold.promise;
    inside = false;
  });
  await firstEntered.promise;
  const second = locks.run("a", async () => {
    assert.equal(inside, false);
    return "second";
  });
  firstHold.resolve();
  await first;
  assert.equal(await second, "second");
});

test("different keys can run together and must not deadlock on a handshake", async () => {
  const locks = createKeyedLock();
  const bEntered = deferred();
  const cEntered = deferred();
  await Promise.all([
    locks.run("b", async () => {
      bEntered.resolve();
      await cEntered.promise;
    }),
    locks.run("c", async () => {
      cEntered.resolve();
      await bEntered.promise;
    }),
  ]);
});

test("a rejected operation does not poison the next waiter on that key", async () => {
  const locks = createKeyedLock();
  await assert.rejects(
    locks.run("k", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await locks.run("k", () => 7), 7);
});
