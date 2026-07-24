import assert from "node:assert/strict";
import test from "node:test";

import { Infini2Controller } from "./controller";
import type { Infini2Page, Infini2Provider } from "./contracts";

interface Row {
  id: number;
  value: string;
}

function page(start: number, count: number): Infini2Page<Row> {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: start + index,
      value: `row-${start + index}`,
    })),
    exhaustedBefore: start === 0,
    exhaustedAfter: start + count >= 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Infini2 state");
}

function controller(provider: Infini2Provider<Row, number, number>) {
  const instance = new Infini2Controller<Row, number, number>({
    provider,
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 10 },
    residentBefore: 2,
    residentAfter: 2,
    layoutBefore: 20,
    layoutAfter: 20,
  });
  instance.setView({ scroll: 0, viewport: 100 });
  return instance;
}

test("bootstrap exposes a 20 viewport runway and exact committed layout", async () => {
  const instance = controller({
    bootstrap: async () => page(5, 10),
    fetch: async ({ direction }) =>
      direction === "before" ? page(0, 5) : page(15, 5),
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  const correction = instance.takeScrollCorrection();
  assert.notEqual(correction, null);
  instance.setView({ scroll: correction!, viewport: 100 });
  const snapshot = instance.getSnapshot();
  assert.equal(snapshot.mainLength, 10);
  assert.equal(snapshot.mainExtent, 100);
  assert.deepEqual(
    snapshot.mainItems.map((item) => item.id),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.equal(snapshot.surfaceExtent, 4_100);
  assert.equal(snapshot.layoutItems.length > 0, true);
  assert.deepEqual(snapshot.residentRange, { first: 5, last: 14 });
  assert.equal(instance.getVisibleItem()?.id, 5);
  assert.equal(
    instance.commitLayout(
      snapshot.layoutRevision,
      snapshot.layoutItems.map((item) => item.handle),
    ),
    true,
  );
  instance.dispose();
});

test("bootstrap never exposes an underfilled VisibleWindow while content is open", async () => {
  const instance = controller({
    bootstrap: async () => ({
      items: page(5, 3).items,
      exhaustedBefore: false,
      exhaustedAfter: false,
    }),
    fetch: async () => page(0, 0),
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "failed");
  const snapshot = instance.getSnapshot();
  assert.equal(snapshot.mainLength, 0);
  assert.equal(snapshot.layoutItems.length, 0);
  assert.equal(
    snapshot.phase.status === "failed" && snapshot.phase.operation,
    "bootstrap",
  );
  instance.dispose();
});

test("delete received during bootstrap is replayed without provider revisions", async () => {
  const run = deferred<Infini2Page<Row>>();
  const instance = controller({
    bootstrap: () => run.promise,
    fetch: async () => page(0, 0),
  });
  instance.start();
  instance.deleteExternal([8]);
  run.resolve({
    items: page(5, 10).items,
    exhaustedBefore: true,
    exhaustedAfter: true,
  });
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(instance.getSnapshot().mainLength, 9);
  assert.equal(instance.getSnapshot().getHandle(8) != null, true);
  instance.dispose();
});

test("insert received during bootstrap is journaled until its anchor arrives", async () => {
  const run = deferred<Infini2Page<Row>>();
  const instance = controller({
    bootstrap: () => run.promise,
    fetch: async () => page(0, 0),
  });
  instance.start();
  assert.equal(
    instance.insertExternal({
      anchor: 7,
      side: "after",
      items: [{ id: 1000, value: "during-request" }],
    }),
    0,
  );
  run.resolve({
    items: page(5, 10).items,
    exhaustedBefore: true,
    exhaustedAfter: true,
  });
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(instance.getSnapshot().mainLength, 11);
  const inserted = instance.getSnapshot().getHandle(1000);
  assert.equal(inserted != null, true);
  assert.equal(
    instance.getSnapshot().getItem(inserted!)?.value,
    "during-request",
  );
  instance.dispose();
});

test("irrelevant external insert does not retain item objects", async () => {
  const instance = controller({
    bootstrap: async () => ({
      items: page(5, 10).items,
      exhaustedBefore: true,
      exhaustedAfter: true,
    }),
    fetch: async () => page(0, 0),
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(
    instance.insertExternal({
      anchor: 999,
      side: "after",
      items: [{ id: 1000, value: "irrelevant" }],
    }),
    0,
  );
  const handle = instance.getSnapshot().getHandle(1000)!;
  assert.equal(instance.getSnapshot().getItem(handle), undefined);
  instance.dispose();
});

test("candidate preparer measurements land before activation", async () => {
  const instance = controller({
    bootstrap: async () => ({
      items: page(5, 3).items,
      exhaustedBefore: true,
      exhaustedAfter: true,
    }),
    fetch: async () => page(0, 0),
  });
  let staged = 0;
  instance.setCandidatePreparer(async (candidate) => {
    staged += 1;
    return candidate.items.map((item, index) => ({
      handle: item.handle,
      extent: 20 + index,
    }));
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(staged, 1);
  const correction = instance.takeScrollCorrection();
  instance.setView({ scroll: correction ?? 0, viewport: 100 });
  assert.equal(instance.getSnapshot().layoutItems[0]?.measured, true);
  instance.dispose();
});

test("external insertion uses a stable anchor and remains incremental", async () => {
  const instance = controller({
    bootstrap: async () => ({
      items: page(5, 5).items,
      exhaustedBefore: true,
      exhaustedAfter: true,
    }),
    fetch: async () => page(0, 0),
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(
    instance.insertExternal({
      anchor: 7,
      side: "after",
      items: [{ id: 1000, value: "inserted" }],
    }),
    1,
  );
  assert.equal(instance.getSnapshot().mainLength, 6);
  instance.dispose();
});

test("a newer jump detaches old work without globally invalidating its result", async () => {
  const first = deferred<Infini2Page<Row>>();
  const second = deferred<Infini2Page<Row>>();
  const instance = new Infini2Controller<Row, number, number, number>({
    provider: {
      bootstrap: ({ cursor }) => {
        if (cursor === 100) return first.promise;
        if (cursor === 200) return second.promise;
        return Promise.resolve(page(5, 10));
      },
      fetch: async () => ({
        items: [],
        exhaustedBefore: true,
        exhaustedAfter: true,
      }),
    },
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 10 },
    targetToCursor: (target) => target,
    locateTarget: (items, target) =>
      items.some((item) => item.id === target) ? target : null,
  });
  instance.setView({ scroll: 0, viewport: 100 });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  const correction = instance.takeScrollCorrection() ?? 0;
  instance.setView({ scroll: correction, viewport: 100 });

  const oldEffect = instance.jump(100);
  instance.jump(200);
  await waitFor(() =>
    instance
      .getSnapshot()
      .effects.some((effect) => effect.id === oldEffect && effect.detached),
  );
  second.resolve({
    items: page(198, 5).items,
    exhaustedBefore: true,
    exhaustedAfter: true,
  });
  await waitFor(
    () =>
      instance.getSnapshot().phase.status === "ready" &&
      instance.getSnapshot().getHandle(200) != null,
  );
  first.resolve({
    items: page(98, 5).items,
    exhaustedBefore: true,
    exhaustedAfter: true,
  });
  await waitFor(() => instance.getSnapshot().staleBeforeIsland !== 0);
  assert.equal(instance.getSnapshot().phase.status, "ready");
  assert.notEqual(instance.getSnapshot().staleBeforeIsland, 0);
  instance.dispose();
});

test("a detached request failure cannot fail the current visible island", async () => {
  const first = deferred<Infini2Page<Row>>();
  const second = deferred<Infini2Page<Row>>();
  const errors: Array<{ foreground: boolean }> = [];
  const instance = new Infini2Controller<Row, number, number, number>({
    provider: {
      bootstrap: ({ cursor }) => {
        if (cursor === 100) return first.promise;
        if (cursor === 200) return second.promise;
        return Promise.resolve(page(5, 10));
      },
      fetch: async () => ({
        items: [],
        exhaustedBefore: true,
        exhaustedAfter: true,
      }),
    },
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 10 },
    targetToCursor: (target) => target,
    locateTarget: (items, target) =>
      items.some((item) => item.id === target) ? target : null,
    onError: (_error, context) => errors.push(context),
  });
  instance.setView({ scroll: 0, viewport: 100 });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  const correction = instance.takeScrollCorrection() ?? 0;
  instance.setView({ scroll: correction, viewport: 100 });
  instance.jump(100);
  instance.jump(200);
  second.resolve({
    items: page(198, 5).items,
    exhaustedBefore: true,
    exhaustedAfter: true,
  });
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  first.reject(new Error("late old failure"));
  await waitFor(() => errors.length === 1);
  assert.equal(errors[0]?.foreground, false);
  assert.equal(instance.getSnapshot().phase.status, "ready");
  instance.dispose();
});

test("edge failure is latched and retry reopens only that frontier", async () => {
  let fetches = 0;
  const instance = controller({
    bootstrap: async () => ({
      items: page(0, 10).items,
      exhaustedBefore: true,
      exhaustedAfter: false,
    }),
    fetch: async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("temporary edge failure");
      return {
        items: page(10, 5).items,
        exhaustedBefore: true,
        exhaustedAfter: true,
      };
    },
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  const correction = instance.takeScrollCorrection() ?? 0;
  instance.setView({ scroll: correction, viewport: 100 });
  await waitFor(() => instance.getSnapshot().phase.status === "failed");
  assert.equal(fetches, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetches, 1);
  instance.retry();
  await waitFor(() => fetches === 2);
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(instance.getSnapshot().mainLength, 15);
  instance.dispose();
});

test("Blank Predict Zone runs locateOffset then activates a measured island", async () => {
  const locateCalls: number[] = [];
  const instance = new Infini2Controller<Row, number, number>({
    provider: {
      bootstrap: async ({ cursor }) =>
        cursor === 100
          ? {
              items: page(97, 12).items,
              exhaustedBefore: false,
              exhaustedAfter: false,
            }
          : {
              items: page(0, 30).items,
              exhaustedBefore: true,
              exhaustedAfter: false,
            },
      fetch: async () => ({
        items: [],
        exhaustedBefore: true,
        exhaustedAfter: true,
      }),
      locateOffset: async ({ signedItemOffset }) => {
        locateCalls.push(signedItemOffset);
        return { cursor: 100, targetId: 102 };
      },
    },
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 0 },
    residentBefore: 2,
    residentAfter: 2,
    layoutBefore: 20,
    layoutAfter: 20,
  });
  instance.setView({ scroll: 0, viewport: 100 });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  const correction = instance.takeScrollCorrection() ?? 0;
  instance.setView({ scroll: correction, viewport: 100 });
  instance.setView({ scroll: 500, viewport: 100 });
  await waitFor(
    () =>
      locateCalls.length === 1 &&
      instance.getSnapshot().getHandle(102) != null &&
      instance.getSnapshot().mainLength === 12,
  );
  assert.equal(locateCalls[0]! > 0, true);
  assert.notEqual(instance.getSnapshot().staleBeforeIsland, 0);
  instance.dispose();
});

test("measurement during a before Blank Predict seek does not pull view to the first row", async () => {
  const locateRun = deferred<{ cursor: number; targetId: number }>();
  let locateCalls = 0;
  let fetchCalls = 0;
  const instance = new Infini2Controller<Row, number, number, number>({
    provider: {
      bootstrap: async () => ({
        items: page(0, 40).items,
        exhaustedBefore: false,
        exhaustedAfter: false,
      }),
      fetch: async () => {
        fetchCalls += 1;
        return {
          items: [],
          exhaustedBefore: true,
          exhaustedAfter: true,
        };
      },
      locateOffset: async () => {
        locateCalls += 1;
        return locateRun.promise;
      },
    },
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 20, target: 20, alignment: "center" },
    targetToCursor: (target) => target,
    locateTarget: (_items, target) => target,
    residentBefore: 2,
    residentAfter: 2,
    layoutBefore: 20,
    layoutAfter: 20,
  });
  instance.setView({ scroll: 0, viewport: 100 });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  instance.setView({
    scroll: instance.takeScrollCorrection()!,
    viewport: 100,
  });
  assert.equal(fetchCalls, 0);

  instance.setView({ scroll: 0, viewport: 100 });
  await waitFor(() => locateCalls === 1);
  const first = instance.getSnapshot().mainItems[0]!;
  instance.captureAnchor(0);
  instance.measure([{ handle: first.handle, extent: 20 }]);

  assert.equal(instance.takeScrollCorrection(), null);
  assert.equal(locateCalls, 1);
  assert.equal(fetchCalls, 0);
  instance.dispose();
});

test("rapid Blank Predict jumps keep only the latest landing in the foreground", async () => {
  const locateRuns = [
    deferred<{ cursor: number; targetId: number }>(),
    deferred<{ cursor: number; targetId: number }>(),
  ];
  const locateOffsets: number[] = [];
  const instance = controller({
    bootstrap: async ({ cursor }) =>
      cursor === 10
        ? page(0, 30)
        : {
            items: page((cursor ?? 2) - 2, 12).items,
            exhaustedBefore: false,
            exhaustedAfter: false,
          },
    fetch: async () => ({
      items: [],
      exhaustedBefore: true,
      exhaustedAfter: true,
    }),
    locateOffset: async ({ signedItemOffset }) => {
      locateOffsets.push(signedItemOffset);
      return locateRuns[locateOffsets.length - 1]!.promise;
    },
  });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  instance.setView({
    scroll: instance.takeScrollCorrection()!,
    viewport: 100,
  });

  instance.setView({ scroll: 2_600, viewport: 100 });
  await waitFor(() => locateOffsets.length === 1);
  instance.setView({ scroll: 3_900, viewport: 100 });
  await waitFor(() => locateOffsets.length === 2);

  locateRuns[1]!.resolve({ cursor: 80, targetId: 80 });
  await waitFor(() =>
    instance.getSnapshot().mainItems.some((row) => row.id === 80),
  );
  locateRuns[0]!.resolve({ cursor: 40, targetId: 40 });
  await waitFor(() => instance.getSnapshot().effects.length === 0);

  const snapshot = instance.getSnapshot();
  assert.equal(
    snapshot.mainItems.some((row) => row.id === 80),
    true,
  );
  assert.equal(
    snapshot.mainItems.some((row) => row.id === 40),
    false,
  );
  assert.notEqual(snapshot.staleBeforeIsland, 0);
  instance.dispose();
});

test("a failed Blank Predict seek stays latched until retry", async () => {
  let locateCalls = 0;
  const errors: Error[] = [];
  const instance = new Infini2Controller<Row, number, number>({
    provider: {
      bootstrap: async ({ cursor }) =>
        cursor === 0
          ? page(0, 30)
          : {
              items: page(48, 12).items,
              exhaustedBefore: false,
              exhaustedAfter: false,
            },
      fetch: async () => ({
        items: [],
        exhaustedBefore: true,
        exhaustedAfter: true,
      }),
      locateOffset: async () => {
        locateCalls += 1;
        if (locateCalls === 1) throw new Error("locate failed");
        return { cursor: 50, targetId: 50 };
      },
    },
    ops: {
      getId: (item) => item.id,
      getCursor: (item) => item.id,
    },
    estimateSize: () => 10,
    defaultItemEstimate: 10,
    initial: { cursor: 0 },
    layoutBefore: 20,
    layoutAfter: 20,
    onError: (error) => errors.push(error),
  });
  instance.setView({ scroll: 0, viewport: 100 });
  instance.start();
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  instance.setView({
    scroll: instance.takeScrollCorrection()!,
    viewport: 100,
  });
  instance.setView({ scroll: 3_000, viewport: 100 });
  await waitFor(() => instance.getSnapshot().phase.status === "failed");

  instance.setView({ scroll: 3_200, viewport: 100 });
  instance.measure([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(locateCalls, 1);
  assert.equal(errors.length, 1);

  instance.retry();
  await waitFor(() => locateCalls === 2);
  await waitFor(() => instance.getSnapshot().phase.status === "ready");
  assert.equal(
    instance.getSnapshot().mainItems.some((row) => row.id === 50),
    true,
  );
  instance.dispose();
});
