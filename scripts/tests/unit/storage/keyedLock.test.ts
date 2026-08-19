import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedLock } from "@/server/storage/keyedLock";

test("operations on one key run one at a time", async () => {
  const lock = createKeyedLock();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = lock.run("same", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
    return 1;
  });
  const second = lock.run("same", async () => {
    order.push("second");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("different keys do not wait for each other", async () => {
  const lock = createKeyedLock();
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const seen: string[] = [];
  const a = lock.run("a", async () => {
    seen.push("a-start");
    await gateA;
    return "a";
  });
  const b = lock.run("b", async () => {
    seen.push("b");
    return "b";
  });
  await Promise.resolve();
  assert.ok(seen.includes("a-start"));
  assert.ok(seen.includes("b"));
  releaseA();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});

test("a thrown operation still releases the key", async () => {
  const lock = createKeyedLock();
  await assert.rejects(
    lock.run("k", () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await lock.run("k", () => "ok"), "ok");
});
