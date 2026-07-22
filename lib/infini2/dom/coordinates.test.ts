import assert from "node:assert/strict";
import test from "node:test";

import { measureInfini2Host } from "./coordinates";

test("element-host coordinates exclude the scroll border", () => {
  const ownerWindow = {} as Window;
  const host = {
    clientHeight: 80,
    clientTop: 4,
    scrollTop: 30,
    getBoundingClientRect: () => ({ top: 100 }),
  } as unknown as HTMLElement;
  const surface = {
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ top: 160 }),
  } as unknown as HTMLElement;

  assert.deepEqual(measureInfini2Host(host, surface), {
    localScroll: -56,
    surfaceOffset: 86,
    viewport: 80,
  });
});

test("window-host coordinates use document scroll space", () => {
  const ownerWindow = {
    innerHeight: 600,
    scrollY: 120,
  } as Window;
  const surface = {
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ top: 30 }),
  } as unknown as HTMLElement;

  assert.deepEqual(measureInfini2Host(ownerWindow, surface), {
    localScroll: -30,
    surfaceOffset: 150,
    viewport: 600,
  });
});
