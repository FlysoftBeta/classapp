import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  Infini2Controller,
  Infini2DomHost,
  Infini2List,
  useInfini2,
  type Infini2ControllerConfig,
  type Infini2Page,
} from "../index";

interface Row {
  id: number;
  label: string;
  height: number;
}

interface BrowserResult {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

declare global {
  interface Window {
    __infini2Result?: BrowserResult;
    __reactInfini2?: Infini2Controller<Row, number, number>;
  }
}

const rows = (start: number, count: number, height = 24): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: start + index,
    label: `row-${start + index}`,
    height,
  }));

const completePage = (items: readonly Row[]): Infini2Page<Row> => ({
  items,
  exhaustedBefore: true,
  exhaustedAfter: true,
});

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let pass = 0; pass < 240; pass += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  throw new Error(message);
};

const config = (
  items: readonly Row[],
): Infini2ControllerConfig<Row, number, number, never> => ({
  provider: {
    bootstrap: async () => completePage(items),
    fetch: async () => completePage([]),
  },
  ops: {
    getId: (item) => item.id,
    getCursor: (item) => item.id,
  },
  estimateSize: (item) => item.height,
  defaultItemEstimate: 24,
  initial: { cursor: null },
  residentBefore: 3,
  residentAfter: 3,
  layoutBefore: 120,
  layoutAfter: 120,
});

function ReactList({ scrollHost }: { scrollHost: HTMLElement }) {
  const { controller, snapshot } = useInfini2(config(rows(100, 30, 28)));
  useEffect(() => {
    window.__reactInfini2 = controller;
  }, [controller]);
  return (
    <>
      <output id="react-phase">{snapshot.phase.status}</output>
      <Infini2List
        controller={controller}
        scrollHost={scrollHost}
        layoutBefore={100}
        layoutAfter={100}
        rowClassName="react-row"
        renderItem={(item) => (
          <div style={{ height: item.height }} data-react-id={item.id}>
            {item.label}
          </div>
        )}
      />
    </>
  );
}

function ReactHarness() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div
      id="react-host"
      ref={setHost}
      style={{ height: 220, overflow: "auto", border: "2px solid black" }}
    >
      {host ? <ReactList scrollHost={host} /> : null}
    </div>
  );
}

async function run() {
  const bareHost = document.querySelector<HTMLDivElement>("#bare-host")!;
  const surface = document.querySelector<HTMLDivElement>("#bare-surface")!;
  Object.assign(bareHost.style, {
    height: "240px",
    overflow: "auto",
    border: "3px solid black",
  });
  const controller = new Infini2Controller(config(rows(0, 40)));
  const dom = new Infini2DomHost({
    controller,
    container: surface,
    scrollHost: bareHost,
    layoutBefore: 120,
    layoutAfter: 120,
    createRow(item) {
      const node = document.createElement("div");
      node.dataset.row = String(item.id);
      node.style.height = `${item.height}px`;
      const input = document.createElement("input");
      input.value = item.label;
      node.appendChild(input);
      return node;
    },
    updateRow(node, item) {
      node.style.height = `${item.height}px`;
      const input = node.querySelector("input");
      if (input) input.value = item.label;
    },
  });
  const liveDuringBootstrap = surface.querySelectorAll(
    "[data-infini2-live-track] > [data-row]",
  ).length;
  controller.start();
  await waitFor(
    () =>
      controller.getSnapshot().phase.status === "ready" &&
      surface.querySelectorAll("[data-infini2-live-track] > [data-row]")
        .length > 0,
    "bare DOM bootstrap did not commit",
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const stagedAfterCommit = surface.querySelector(
    "[data-infini2-staging] [data-row]",
  );
  const liveTrack = surface.querySelector<HTMLElement>(
    "[data-infini2-live-track]",
  );
  const liveCount = surface.querySelectorAll(
    "[data-infini2-live-track] > [data-row]",
  ).length;
  if (stagedAfterCommit)
    throw new Error("candidate rows remained mounted after commit");
  if (!liveTrack || !liveTrack.style.transform) {
    throw new Error("flow-based live track was not installed");
  }
  if (
    [...liveTrack.querySelectorAll<HTMLElement>("[data-row]")].some(
      (node) => node.style.transform !== "none",
    )
  ) {
    throw new Error("a live row retained its own positioning transform");
  }
  if (liveCount >= 40)
    throw new Error("layout virtualization did not evict rows");
  if (Math.abs(parseFloat(surface.style.height) - 960) > 0.5) {
    throw new Error(
      `unexpected measured surface height ${surface.style.height}`,
    );
  }

  const originalRowRect = HTMLElement.prototype.getBoundingClientRect;
  let rowRectReads = 0;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset.row) rowRectReads += 1;
    return originalRowRect.call(this);
  };
  try {
    bareHost.scrollTop = 180;
    bareHost.dispatchEvent(new Event("scroll"));
    await waitFor(
      () => surface.querySelector('[data-row="20"]') != null,
      "flow track did not batch the next Layout rows",
    );
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRowRect;
  }
  if (rowRectReads !== 0) {
    throw new Error(
      `performLayout synchronously measured ${rowRectReads} live rows`,
    );
  }

  if (!dom.scrollToItem(5, "start")) {
    throw new Error("laid-out item refused an imperative local scroll");
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (Math.abs(bareHost.scrollTop - 120) > 1) {
    throw new Error(`imperative local scroll landed at ${bareHost.scrollTop}`);
  }
  const stable = surface.querySelector<HTMLElement>('[data-row="5"]')!;
  const focused = stable.querySelector("input")!;
  focused.focus();
  const beforeTop = stable.getBoundingClientRect().top;
  const beforeScroll = bareHost.scrollTop;
  controller.insertExternal({
    anchor: 0,
    side: "before",
    items: [{ id: 1000, label: "prepended", height: 35 }],
  });
  await waitFor(
    () => bareHost.scrollTop > beforeScroll,
    "prepend scroll compensation was not applied",
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const stableAfter = surface.querySelector<HTMLElement>('[data-row="5"]')!;
  if (stableAfter !== stable)
    throw new Error("appendChild did not preserve row identity");
  if (document.activeElement !== focused)
    throw new Error("focused descendant was lost");
  const afterTop = stableAfter.getBoundingClientRect().top;
  if (Math.abs(afterTop - beforeTop) > 1) {
    throw new Error(
      `semantic waterline moved after prepend: top ${beforeTop} -> ${afterTop}, scroll ${beforeScroll} -> ${bareHost.scrollTop}`,
    );
  }
  if (bareHost.scrollTop <= beforeScroll) {
    throw new Error("prepend did not compensate scrollTop");
  }
  const prependCompensatedBy = bareHost.scrollTop - beforeScroll;

  bareHost.scrollTop = 700;
  bareHost.dispatchEvent(new Event("scroll"));
  await waitFor(
    () => surface.querySelector("[data-infini2-gap]") != null,
    "focus-pinned row did not form a discontinuous flow-track gap",
  );
  if (document.activeElement !== focused) {
    throw new Error("flow-track window shift lost the focused pinned row");
  }
  if (!dom.scrollToItem(5, "start")) {
    throw new Error("focus-pinned row was absent from Layout");
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  bareHost.scrollTop = parseFloat(surface.style.height) - bareHost.clientHeight;
  bareHost.dispatchEvent(new Event("scroll"));
  await waitFor(
    () => surface.querySelector('[data-row="39"]') != null,
    "last existing row did not enter the bottom Layout",
  );
  controller.insertExternal({
    anchor: 39,
    side: "after",
    items: [{ id: 40, label: "appended", height: 60 }],
  });
  if (!dom.scrollToItem(40, "end")) {
    throw new Error("newly appended Layout row rejected deferred end scroll");
  }
  await waitFor(() => {
    const expectedBottom =
      parseFloat(surface.style.height) - bareHost.clientHeight;
    return (
      surface.querySelector('[data-row="40"]') != null &&
      Math.abs(bareHost.scrollTop - expectedBottom) <= 1
    );
  }, "deferred end scroll did not land at the measured surface bottom");

  const reactRoot = createRoot(document.querySelector("#react-root")!);
  reactRoot.render(
    <StrictMode>
      <ReactHarness />
    </StrictMode>,
  );
  await waitFor(
    () =>
      document.querySelector("#react-phase")?.textContent === "ready" &&
      document.querySelector("[data-react-id]") != null,
    "React StrictMode integration did not become ready",
  );
  const reactController = window.__reactInfini2!;
  const reactNode = document.querySelector<HTMLElement>(
    '[data-react-id="100"]',
  )!;
  reactController.updateExternal([{ id: 100, label: "updated", height: 28 }]);
  await waitFor(
    () => reactNode.textContent === "updated",
    "portal content did not update",
  );
  if (document.querySelector('[data-react-id="100"]') !== reactNode) {
    throw new Error("React portal row identity changed during update");
  }

  reactRoot.unmount();
  await Promise.resolve();
  let disposed = false;
  try {
    reactController.getSnapshot();
  } catch {
    disposed = true;
  }
  if (!disposed)
    throw new Error("useInfini2 did not dispose after real unmount");

  const spacer = document.createElement("div");
  spacer.style.height = "400px";
  const windowSurface = document.createElement("div");
  const windowFooter = document.createElement("div");
  windowFooter.style.height = "80px";
  document.body.append(spacer, windowSurface, windowFooter);
  const windowInitialRows = rows(200, 30, 32);
  const windowEndRows = rows(300, 40, 32);
  const windowController = new Infini2Controller<Row, number, number, number>({
    ...config(windowInitialRows),
    provider: {
      bootstrap: async ({ cursor }) =>
        cursor === 339
          ? {
              items: windowEndRows,
              exhaustedBefore: false,
              exhaustedAfter: true,
            }
          : completePage(windowInitialRows),
      fetch: async () => completePage([]),
    },
    targetToCursor: (target) => target,
    locateTarget: (items, target) =>
      items.some((item) => item.id === target) ? target : null,
  });
  const windowDom = new Infini2DomHost({
    controller: windowController,
    container: windowSurface,
    paddingEnd: 80,
    createRow(item) {
      const node = document.createElement("div");
      node.dataset.windowRow = String(item.id);
      node.style.height = `${item.height}px`;
      return node;
    },
  });
  windowController.start();
  await waitFor(
    () =>
      windowController.getSnapshot().phase.status === "ready" &&
      windowSurface.querySelector("[data-window-row]") != null &&
      window.scrollY > 0,
    "window scroll host did not commit",
  );
  const windowSurfaceOffset =
    windowSurface.getBoundingClientRect().top + window.scrollY;
  if (Math.abs(window.scrollY - windowSurfaceOffset) > 1) {
    throw new Error(
      `window scroll host did not apply local target coordinates: scroll=${window.scrollY}, surface=${windowSurfaceOffset}`,
    );
  }
  if (windowDom.scrollToItem(339, "end")) {
    throw new Error("window target unexpectedly bypassed seek");
  }
  windowController.jump(339, { alignment: "end" });
  await waitFor(
    () =>
      windowController.getSnapshot().phase.status === "ready" &&
      windowSurface.querySelector('[data-window-row="339"]') != null,
    "window end-target seek did not activate",
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const windowLast = windowSurface.querySelector<HTMLElement>(
    '[data-window-row="339"]',
  )!;
  const expectedWindowLastBottom = window.innerHeight - 80;
  const actualWindowLastBottom = windowLast.getBoundingClientRect().bottom;
  if (Math.abs(actualWindowLastBottom - expectedWindowLastBottom) > 1) {
    throw new Error(
      `window end-target seek landed at ${actualWindowLastBottom}, expected ${expectedWindowLastBottom}`,
    );
  }
  windowDom.dispose();
  windowController.dispose();
  spacer.remove();
  windowSurface.remove();
  windowFooter.remove();

  const runwayHost = document.createElement("div");
  const runwaySurface = document.createElement("div");
  runwayHost.appendChild(runwaySurface);
  document.body.appendChild(runwayHost);
  Object.assign(runwayHost.style, {
    height: "240px",
    overflow: "auto",
  });
  const runwayRows = rows(300, 40);
  const runwayController = new Infini2Controller<Row, number, number, never>({
    ...config(runwayRows),
    provider: {
      bootstrap: async () => ({
        items: runwayRows,
        exhaustedBefore: false,
        exhaustedAfter: true,
      }),
      fetch: async () => completePage([]),
    },
    initial: { cursor: null, alignment: "end" },
  });
  const runwayDom = new Infini2DomHost({
    controller: runwayController,
    container: runwaySurface,
    scrollHost: runwayHost,
    layoutBefore: 120,
    layoutAfter: 120,
    createRow(item) {
      const node = document.createElement("div");
      node.dataset.runwayRow = String(item.id);
      node.style.height = `${item.height}px`;
      return node;
    },
  });
  runwayController.start();
  await waitFor(
    () =>
      runwayController.getSnapshot().phase.status === "ready" &&
      runwaySurface.querySelector('[data-runway-row="339"]') != null,
    "open-before runway did not bootstrap at Content End",
  );
  if (!runwayDom.scrollToItem(339, "end")) {
    throw new Error("open-before last item rejected end scroll");
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const runwaySnapshot = runwayController.getSnapshot();
  const expectedRunwayBottom =
    runwaySnapshot.surfaceExtent - runwayHost.clientHeight;
  if (Math.abs(runwayHost.scrollTop - expectedRunwayBottom) > 1) {
    throw new Error(
      `open-before end scroll landed at ${runwayHost.scrollTop}, expected ${expectedRunwayBottom}, origin ${runwaySnapshot.islandOrigin}`,
    );
  }
  const runwayLast = runwaySurface.querySelector<HTMLElement>(
    '[data-runway-row="339"]',
  )!;
  runwayLast.style.height = "224px";
  if (!runwayDom.scrollToItem(339, "end")) {
    throw new Error("dynamically resized last item rejected end scroll");
  }
  const runwayHostRect = runwayHost.getBoundingClientRect();
  const expectedVisualBottom =
    runwayHostRect.top + runwayHost.clientTop + runwayHost.clientHeight;
  const actualVisualBottom = runwayLast.getBoundingClientRect().bottom;
  if (Math.abs(actualVisualBottom - expectedVisualBottom) > 1) {
    throw new Error(
      `end scroll used stale core extent: item bottom ${actualVisualBottom}, viewport bottom ${expectedVisualBottom}`,
    );
  }
  const runwayOrigin = runwaySnapshot.islandOrigin;
  const runwayBottom = runwayHost.scrollTop;
  runwayDom.dispose();
  runwayController.dispose();
  runwayHost.remove();

  const seekHost = document.createElement("div");
  const seekSurface = document.createElement("div");
  seekHost.appendChild(seekSurface);
  document.body.appendChild(seekHost);
  Object.assign(seekHost.style, {
    height: "240px",
    overflow: "auto",
  });
  const seekInitialRows = rows(0, 200);
  const seekEndRows = rows(160, 40);
  const seekController = new Infini2Controller<Row, number, number, number>({
    ...config(seekInitialRows),
    provider: {
      bootstrap: async ({ cursor }) =>
        cursor === 199
          ? {
              items: seekEndRows,
              exhaustedBefore: false,
              exhaustedAfter: true,
            }
          : {
              items: seekInitialRows,
              exhaustedBefore: false,
              exhaustedAfter: true,
            },
      fetch: async () => completePage([]),
    },
    targetToCursor: (target) => target,
    locateTarget: (items, target) =>
      items.some((item) => item.id === target) ? target : null,
    initial: { cursor: null, target: 100, alignment: "center" },
  });
  const seekDom = new Infini2DomHost({
    controller: seekController,
    container: seekSurface,
    scrollHost: seekHost,
    layoutBefore: 120,
    layoutAfter: 120,
    createRow(item) {
      const node = document.createElement("div");
      node.dataset.seekRow = String(item.id);
      node.style.height = `${item.height}px`;
      return node;
    },
  });
  seekController.start();
  await waitFor(
    () =>
      seekController.getSnapshot().phase.status === "ready" &&
      seekSurface.querySelector('[data-seek-row="100"]') != null,
    "seek fixture did not finish its initial bootstrap",
  );
  let liveSeekTargetRectReads = 0;
  const originalSeekRowRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (
      this.dataset.seekRow === "199" &&
      this.parentElement?.dataset.infini2LiveTrack != null
    ) {
      liveSeekTargetRectReads += 1;
    }
    return originalSeekRowRect.call(this);
  };
  if (seekDom.scrollToItem(199, "end")) {
    throw new Error("out-of-layout target unexpectedly bypassed seek");
  }
  seekController.jump(199, { alignment: "end" });
  try {
    await waitFor(
      () =>
        seekController.getSnapshot().phase.status === "ready" &&
        seekSurface.querySelector('[data-seek-row="199"]') != null &&
        liveSeekTargetRectReads > 0,
      "end-target seek did not finish its deferred physical alignment",
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalSeekRowRect;
  }
  const seekLast = seekSurface.querySelector<HTMLElement>(
    '[data-seek-row="199"]',
  )!;
  const seekHostRect = seekHost.getBoundingClientRect();
  const expectedSeekBottom =
    seekHostRect.top + seekHost.clientTop + seekHost.clientHeight;
  const actualSeekBottom = seekLast.getBoundingClientRect().bottom;
  if (Math.abs(actualSeekBottom - expectedSeekBottom) > 1) {
    throw new Error(
      `end-target seek landed at item bottom ${actualSeekBottom}, expected ${expectedSeekBottom}; scroll=${seekHost.scrollTop}, origin=${seekController.getSnapshot().islandOrigin}`,
    );
  }
  seekDom.dispose();
  seekController.dispose();
  seekHost.remove();

  dom.dispose();
  controller.dispose();
  return {
    liveDuringBootstrap,
    liveAfterCommit: liveCount,
    liveRowRectReads: rowRectReads,
    compensatedBy: prependCompensatedBy,
    windowHostOffset: windowSurfaceOffset,
    runwayOrigin,
    runwayBottom,
  };
}

void run().then(
  (details) => {
    window.__infini2Result = { ok: true, details };
  },
  (error: unknown) => {
    window.__infini2Result = {
      ok: false,
      error: error instanceof Error ? error.stack : String(error),
    };
  },
);
