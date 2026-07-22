/** Browser window or overflow element that owns the physical scroll position. */
export type Infini2ScrollHost = Window | HTMLElement;

/** Host geometry translated into Infini2 surface-local coordinates. */
export interface Infini2HostMetrics {
  /** Scroll position relative to the Infini2 surface start. */
  localScroll: number;
  /** Infini2 surface start in the host's scroll coordinate space. */
  surfaceOffset: number;
  /** Physical host viewport block extent in CSS pixels. */
  viewport: number;
}

/**
 * Measures a window or element scroll host relative to an Infini2 surface.
 *
 * @remarks Element-host coordinates subtract `clientTop`, because the border is
 * outside scroll content coordinates. The surface must belong to a live document.
 * @throws If the surface has no owning window.
 */
export function measureInfini2Host(
  host: Infini2ScrollHost,
  surface: HTMLElement,
): Infini2HostMetrics {
  const ownerWindow = surface.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Infini2 requires a live document");
  if (host === ownerWindow) {
    const scroll = ownerWindow.scrollY;
    const surfaceOffset = surface.getBoundingClientRect().top + scroll;
    return {
      localScroll: scroll - surfaceOffset,
      surfaceOffset,
      viewport: ownerWindow.innerHeight,
    };
  }
  const element = host as HTMLElement;
  const hostRect = element.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const surfaceOffset = surfaceRect.top - hostRect.top + element.scrollTop;
  const contentOffset = surfaceOffset - element.clientTop;
  return {
    localScroll: element.scrollTop - contentOffset,
    surfaceOffset: contentOffset,
    viewport: element.clientHeight,
  };
}

/**
 * Instantly writes an absolute surface-local target to a physical scroll host.
 *
 * @param surfaceOffset - Current surface start in host scroll coordinates.
 * @param localScroll - Desired scroll relative to that surface start.
 */
export function scrollInfini2Host(
  host: Infini2ScrollHost,
  surfaceOffset: number,
  localScroll: number,
): void {
  const target = surfaceOffset + localScroll;
  if ("scrollTo" in host) {
    if (host instanceof Window) {
      host.scrollTo({ top: target, behavior: "instant" });
    } else {
      host.scrollTo({ top: target, behavior: "instant" });
    }
  }
}
