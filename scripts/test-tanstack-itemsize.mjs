/**
 * TanStack Virtual itemSize / index-shift behavior tests.
 * Run: node scripts/test-tanstack-itemsize.mjs
 *
 * Focus: itemSizeCache (keyed by getItemKey), NOT scroll compensation.
 */

import { Virtualizer } from "@tanstack/virtual-core";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function makeV(idsRef, { estimateSize = () => 76 } = {}) {
  const getItemKey = (i) => idsRef[i];
  return {
    v: new Virtualizer({
      count: idsRef.length,
      getScrollElement: () => null,
      estimateSize,
      getItemKey,
      overscan: 0,
      initialRect: { width: 400, height: 600 },
      initialOffset: 0,
      scrollToFn: () => {},
      observeElementRect: () => undefined,
      observeElementOffset: () => undefined,
    }),
    idsRef,
    refresh(ids) {
      idsRef.length = 0;
      idsRef.push(...ids);
      this.v.setOptions({ ...this.v.options, count: idsRef.length });
    },
  };
}

function sizesByKey(v, idsRef) {
  v.getTotalSize();
  const out = new Map();
  for (let i = 0; i < idsRef.length; i++) {
    const key = v.options.getItemKey(i);
    const m = v.measurementsCache[i];
    out.set(key, {
      index: i,
      layoutSize: m?.size,
      cached: v.itemSizeCache.get(key),
    });
  }
  return out;
}

console.log(
  "\n=== 1. prepend: itemSizeCache 按 key 保留，index 重算后 size 仍正确 ===\n",
);

{
  const idsRef = ["a", "b", "c"];
  const ctx = makeV(idsRef);
  const { v } = ctx;
  v.getTotalSize();
  v.resizeItem(0, 100);
  v.resizeItem(1, 120);
  v.resizeItem(2, 80);

  const before = sizesByKey(v, idsRef);
  assert(before.get("a").cached === 100, "a cached=100");
  assert(before.get("b").cached === 120, "b cached=120");

  ctx.refresh(["x", "y", "a", "b", "c"]);

  const after = sizesByKey(v, idsRef);
  assert(after.get("a").index === 2, "a moved to index 2");
  assert(after.get("a").cached === 100, "a size still 100 after prepend");
  assert(after.get("b").cached === 120, "b size still 120 after prepend");
  assert(after.get("x").cached === undefined, "new x has no cache yet");
  assert(after.get("x").layoutSize === 76, "new x uses estimate 76");
}

console.log(
  "\n=== 2. 稳定 getItemKey 引用 + count 变：measurement 从 0 重算，key→size 不错乱 ===\n",
);

{
  const idsRef = ["m1", "m2", "m3"];
  const ctx = makeV(idsRef);
  const { v } = ctx;
  v.getTotalSize();
  v.resizeItem(2, 200); // m3 tall

  ctx.refresh(["old1", "old2", "m1", "m2", "m3"]);

  const after = sizesByKey(v, idsRef);
  assert(after.get("m3").cached === 200, "m3 keeps measured 200");
  assert(after.get("m1").layoutSize === 76, "m1 layout uses estimate");
  const m3 = v.measurementsCache[4];
  assert(m3?.start === 76 * 4, "m3 start = 4*estimate");
}

console.log(
  "\n=== 3. 【核心】stale data-index：DOM 旧 index + 新数组 → 错绑 itemSize ===\n",
);

{
  const idsRef = ["a", "b", "c"];
  const ctx = makeV(idsRef);
  const { v } = ctx;
  v.getTotalSize();

  v.resizeItem(0, 150);
  assert(v.itemSizeCache.get("a") === 150, "a measured 150");

  ctx.refresh(["x", "y", "a", "b", "c"]);

  const staleDomIndex = 0;
  const wrongKey = v.options.getItemKey(staleDomIndex);
  const measuredHeight = 150;

  assert(wrongKey === "x", "stale index 0 now maps to x, not a");

  v.resizeItem(staleDomIndex, measuredHeight);

  assert(
    v.itemSizeCache.get("x") === 150,
    "BUG: a's 150px wrongly cached under key x",
  );
  assert(v.itemSizeCache.get("a") === 150, "a still has old cache 150");

  const layout = sizesByKey(v, idsRef);
  assert(layout.get("x").layoutSize === 150, "x layout uses wrong 150px");
  assert(layout.get("a").layoutSize === 150, "a layout still correct 150px");
  console.log(
    "  → 结论：stale data-index 会把旧 DOM 高度写到新 index 对应的 key 上",
  );
}

console.log("\n=== 4. getItemKey 与 estimateSize 数据源不一致 ===\n");

{
  const idsRef = ["a", "b"];
  const itemsSnapshot = { value: idsRef };
  const getItemKey = (i) => itemsSnapshot.value[i];
  const estimateSize = (i) => (idsRef[i] ? 50 : 76);

  const v = new Virtualizer({
    count: idsRef.length,
    getScrollElement: () => null,
    estimateSize,
    getItemKey,
    overscan: 0,
    initialRect: { width: 400, height: 600 },
    initialOffset: 0,
    scrollToFn: () => {},
    observeElementRect: () => undefined,
    observeElementOffset: () => undefined,
  });
  v.getTotalSize();

  // getItemKey 闭包仍指向旧 snapshot，idsRef 已 mutate
  itemsSnapshot.value = ["x", "a", "b"];
  idsRef.length = 0;
  idsRef.push("x", "a", "b");
  v.setOptions({ ...v.options, count: idsRef.length });
  v.getTotalSize();

  const m0 = v.measurementsCache[0];
  const m2 = v.measurementsCache[2];
  assert(m0?.key === "x", "getItemKey via snapshot: index0=x");
  assert(m0?.size === 50, "estimate via idsRef: x gets 50");
  assert(m2?.key === "b", "index2=b");
  assert(m2?.size === 50, "b estimate 50");
  console.log(
    `  index0 key=${m0?.key} size=${m0?.size}, index2 key=${m2?.key} size=${m2?.size}`,
  );
}

console.log("\n=== 5. measureElement 路径：index → key → elementsCache ===\n");

{
  const idsRef = ["p1", "p2"];
  const ctx = makeV(idsRef);
  const { v } = ctx;
  v.getTotalSize();

  ctx.refresh(["new0", "p1", "p2"]);
  v.getTotalSize();

  const goodNode = {
    getAttribute: (name) => (name === "data-index" ? "2" : null),
    isConnected: true,
    offsetHeight: 180,
  };
  v.measureElement(goodNode);
  assert(
    v.itemSizeCache.get("p1") === 180,
    "correct data-index=2 → p1 gets 180px",
  );

  const staleNode = {
    getAttribute: () => "1",
    isConnected: true,
    offsetHeight: 180,
  };
  ctx.refresh(["new0", "new1", "p1", "p2"]);
  const staleKey = v.options.getItemKey(v.indexFromElement(staleNode));
  assert(staleKey === "new1", "stale data-index=1 now maps to new1, not p1");
  v.measureElement(staleNode);
  assert(
    v.itemSizeCache.get("new1") === 180,
    "p1's DOM height wrongly stored as new1's size",
  );
}

console.log(
  "\n=== 6. pendingMin 增量重算：prepend 后 min=0，全量重算仍用 itemSizeCache ===\n",
);

{
  const idsRef = ["a", "b", "c", "d", "e"];
  const ctx = makeV(idsRef);
  const { v } = ctx;
  v.getTotalSize();
  for (let i = 0; i < 5; i++) v.resizeItem(i, 80 + i * 10);

  const totalBefore = v.getTotalSize();
  ctx.refresh(["n1", "n2", ...idsRef]);
  const totalAfter = v.getTotalSize();

  assert(totalAfter === totalBefore + 76 * 2, "prepend adds 2 estimates");
  assert(v.itemSizeCache.get("e") === 120, "e cached size preserved");
}

console.log("\n--- Summary ---");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
