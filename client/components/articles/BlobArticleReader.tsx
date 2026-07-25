import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import ZoomOutIcon from "@mui/icons-material/ZoomOut";
import { fetchArticleRender, saveArticleProgress } from "@/client/api/articles";
import {
  fetchReaderConfig,
  updateReaderConfig,
} from "@/client/api/readerConfig";
import type { UserConfigChangedEvent } from "@/client/hooks/useAppLogic";
import {
  BLOB_READER_ZOOM_MAX,
  BLOB_READER_ZOOM_MIN,
} from "@/shared/userConfig/reader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import {
  clampBlobReaderZoom,
  parseBlobReaderGrayscale,
  parseBlobReaderZoom,
} from "@/shared/userConfig/reader";

const ZOOM_MIN = BLOB_READER_ZOOM_MIN;
const ZOOM_MAX = BLOB_READER_ZOOM_MAX;
const ZOOM_STEP = 0.1;
const ZOOM_THROTTLE_MS = 200;
const ZOOM_SAVE_DEBOUNCE_MS = 500;
const PAGE_FLIP_FAST_THRESHOLD_MS = 200;
const PAGE_FLIP_IDLE_MS = 200;
const RENDER_PRELOAD_RADIUS = 2;
const RENDER_BACK_PRELOAD_RADIUS = 1;
const VIEWPORT_SIZE_THRESHOLD = 8;

function renderCacheKey(page: number, width: number, height: number) {
  return `${page}:${width}:${height}`;
}

function inflightPageKey(
  articleId: string,
  page: number,
  width: number,
  height: number,
) {
  return `${articleId}:${page}:${width}:${height}`;
}

function getDevicePixelRatio() {
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

function bitmapToLayoutSize(naturalWidth: number, naturalHeight: number) {
  const dpr = getDevicePixelRatio();
  return {
    width: Math.round(naturalWidth / dpr),
    height: Math.round(naturalHeight / dpr),
  };
}

function getPhysicalSize(
  layoutWidth: number,
  layoutHeight: number,
  zoom: number,
) {
  const dpr = getDevicePixelRatio();
  return {
    width: Math.round(layoutWidth * zoom * dpr),
    height: Math.round(layoutHeight * zoom * dpr),
  };
}

function clampPageIndex(pageIndex: number, totalPages: number | null) {
  const max =
    totalPages != null ? Math.max(0, totalPages - 1) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(max, pageIndex));
}

function getPreloadPages(
  centerPage: number,
  direction: "forward" | "backward" | "init",
): number[] {
  const pages: number[] = [];
  const backRadius = direction === "forward" ? 0 : RENDER_BACK_PRELOAD_RADIUS;
  for (let delta = backRadius; delta >= 1; delta--) {
    const page = centerPage - delta;
    if (page >= 0) pages.push(page);
  }
  for (let delta = 1; delta <= RENDER_PRELOAD_RADIUS; delta++) {
    pages.push(centerPage + delta);
  }
  return pages;
}

function revokeObjectUrlMap(map: Map<string, string>) {
  for (const url of map.values()) {
    URL.revokeObjectURL(url);
  }
  map.clear();
}

function pruneRenderCache(
  cache: Map<string, string>,
  physicalWidth: number,
  physicalHeight: number,
) {
  const suffix = `:${physicalWidth}:${physicalHeight}`;
  for (const [key, url] of [...cache.entries()]) {
    if (key.endsWith(suffix)) continue;
    URL.revokeObjectURL(url);
    cache.delete(key);
  }
}

/** 当前页 > 向后翻（页码增大）> 向前翻；同方向距离越近越高 */
function computeFetchPriority(
  targetPage: number,
  centerPage: number,
  isUserPage: boolean,
) {
  if (isUserPage) return 1_000_000;
  const distance = Math.abs(targetPage - centerPage);
  const towardLaterPages = targetPage > centerPage;
  const directionScore = towardLaterPages ? 10_000 : 0;
  const distanceScore = Math.max(0, 1_000 - distance * 100);
  return directionScore + distanceScore;
}

type FetchQueueItem<T> = {
  priority: number;
  order: number;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createFetchQueue() {
  let items: FetchQueueItem<unknown>[] = [];
  let pumping = false;
  let order = 0;

  function reset() {
    items = [];
    pumping = false;
    order = 0;
  }

  function enqueue<T>(task: () => Promise<T>, priority: number): Promise<T> {
    return new Promise((resolve, reject) => {
      items.push({
        priority,
        order: order++,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void pump();
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (items.length > 0) {
        items.sort((a, b) => b.priority - a.priority || a.order - b.order);
        const item = items.shift()!;
        try {
          item.resolve(await item.task());
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      pumping = false;
      if (items.length > 0) void pump();
    }
  }

  return { enqueue, reset };
}

function touchDistance(touches: TouchList) {
  if (touches.length < 2) return 0;
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(touches: TouchList) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

type ZoomPointAnchor = {
  rx: number;
  ry: number;
  oldWidth: number;
  oldHeight: number;
  scale: number;
};

function buildZoomPointAnchor(
  clientX: number,
  clientY: number,
  imgRect: DOMRect,
  scale: number,
): ZoomPointAnchor {
  return {
    rx: Math.min(1, Math.max(0, (clientX - imgRect.left) / imgRect.width)),
    ry: Math.min(1, Math.max(0, (clientY - imgRect.top) / imgRect.height)),
    oldWidth: imgRect.width,
    oldHeight: imgRect.height,
    scale,
  };
}

interface BlobArticleReaderProps {
  articleId: string;
  token: string;
  title: string;
  initialPage: number;
  themeMode: "light" | "dark";
  subscribeConfigEvents?: (
    fn: (evt: UserConfigChangedEvent) => void,
  ) => () => void;
}

export default function BlobArticleReader({
  articleId,
  token,
  title,
  initialPage,
  themeMode,
  subscribeConfigEvents,
}: BlobArticleReaderProps) {
  const [page, setPage] = useState(initialPage);
  const [renderPage, setRenderPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [pendingZoom, setPendingZoom] = useState<number | null>(null);
  const [sliderZoom, setSliderZoom] = useState(1);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [imageSize, setImageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewport, setViewport] = useState<{
    articleId: string;
    width: number;
    height: number;
  } | null>(null);
  const [panelInsets, setPanelInsets] = useState({ left: 0, right: 0 });
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [grayscale, setGrayscale] = useState(false);
  const [pageDialogOpen, setPageDialogOpen] = useState(false);
  const [pageInput, setPageInput] = useState("");
  const [pageInputError, setPageInputError] = useState("");

  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const hScrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollSizeRef = useRef<{
    size: { width: number; height: number };
    preserveScroll: boolean;
  } | null>(null);
  const scrollSnapshotRef = useRef<{
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
    windowScrollY: number;
    displayHeight: number;
    contentTop: number;
  } | null>(null);
  const viewportStateRef = useRef(viewport);
  const cacheRef = useRef<Map<string, string>>(new Map());
  const inflightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const fetchQueueRef = useRef(createFetchQueue());
  const lastPageRef = useRef(initialPage);
  const pageRef = useRef(initialPage);
  const lastPageFlipTimeRef = useRef(0);
  const fastFlipRef = useRef(false);
  const fastFlipIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const zoomRef = useRef(1);
  const zoomThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextRef = useRef({ articleId: "", zoom: 1 });
  const totalPagesRef = useRef<number | null>(null);
  const imageSizeRef = useRef(imageSize);
  const sliderZoomRef = useRef(sliderZoom);
  const zoomStateRef = useRef(zoom);
  const urlRef = useRef(url);
  const pinchRef = useRef<{
    startDistance: number;
    startZoom: number;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startWindowScrollY: number;
  } | null>(null);
  const zoomPointAnchorRef = useRef<ZoomPointAnchor | null>(null);
  const scheduleZoomRef = useRef<
    (nextZoom: number, options?: { captureScroll?: boolean }) => void
  >(() => {});
  const commitZoomRef = useRef<(nextZoom: number) => void>(() => {});

  useEffect(() => {
    viewportStateRef.current = viewport;
    totalPagesRef.current = totalPages;
    imageSizeRef.current = imageSize;
    sliderZoomRef.current = sliderZoom;
    zoomStateRef.current = zoom;
    urlRef.current = url;
    pageRef.current = page;
  }, [viewport, totalPages, imageSize, sliderZoom, zoom, url, page]);

  const getImageDocumentTop = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return 0;
    return el.getBoundingClientRect().top + window.scrollY;
  }, []);

  const captureScrollSnapshot = useCallback(
    (displayHeight: number) => {
      const hScroll = hScrollRef.current;
      if (!hScroll || displayHeight <= 0) return;
      scrollSnapshotRef.current = {
        scrollLeft: hScroll.scrollLeft,
        scrollWidth: hScroll.scrollWidth,
        clientWidth: hScroll.clientWidth,
        windowScrollY: window.scrollY,
        displayHeight,
        contentTop: getImageDocumentTop(),
      };
    },
    [getImageDocumentTop],
  );

  const captureCurrentScrollSnapshot = useCallback(() => {
    const size = imageSizeRef.current;
    if (!size) return;
    const displayHeight =
      size.height * (sliderZoomRef.current / zoomStateRef.current);
    captureScrollSnapshot(displayHeight);
  }, [captureScrollSnapshot]);

  const restoreScrollFromSnapshot = useCallback((newDisplayHeight: number) => {
    const snap = scrollSnapshotRef.current;
    const hScroll = hScrollRef.current;
    if (!snap || !hScroll || newDisplayHeight <= 0) return;

    const oldMaxScroll = Math.max(0, snap.scrollWidth - snap.clientWidth);
    const newMaxScroll = Math.max(0, hScroll.scrollWidth - hScroll.clientWidth);
    if (oldMaxScroll > 0 && newMaxScroll > 0) {
      hScroll.scrollLeft = (snap.scrollLeft / oldMaxScroll) * newMaxScroll;
    } else {
      hScroll.scrollLeft = 0;
    }

    if (snap.displayHeight > 0) {
      const viewAnchorY =
        snap.windowScrollY + window.innerHeight / 2 - snap.contentTop;
      const relativeAnchor = viewAnchorY / snap.displayHeight;
      const newViewAnchorY =
        snap.contentTop + relativeAnchor * newDisplayHeight;
      window.scrollTo(0, Math.max(0, newViewAnchorY - window.innerHeight / 2));
    }

    scrollSnapshotRef.current = null;
  }, []);

  const applyZoomPointAnchor = useCallback((anchor: ZoomPointAnchor) => {
    const hScroll = hScrollRef.current;
    if (!hScroll) return;
    const deltaX = anchor.rx * anchor.oldWidth * (anchor.scale - 1);
    const deltaY = anchor.ry * anchor.oldHeight * (anchor.scale - 1);
    hScroll.scrollLeft += deltaX;
    window.scrollTo(0, window.scrollY + deltaY);
  }, []);

  const scrollReaderToTop = useCallback(() => {
    const reader = contentRef.current?.closest("[data-article-reader]");
    if (!reader) {
      window.scrollTo(0, 0);
      return;
    }
    const top = reader.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top));
  }, []);

  const resetScrollPosition = useCallback(
    (size: { width: number; height: number }) => {
      scrollReaderToTop();
      const hScroll = hScrollRef.current;
      if (!hScroll) return;
      const overflow = size.width - hScroll.clientWidth;
      hScroll.scrollLeft = overflow > 0 ? overflow / 2 : 0;
    },
    [scrollReaderToTop],
  );

  const clearCache = useCallback(() => {
    revokeObjectUrlMap(cacheRef.current);
    inflightRef.current.clear();
    fetchQueueRef.current.reset();
    pendingScrollSizeRef.current = null;
    setUrl("");
    setImageSize(null);
  }, []);

  useLayoutEffect(() => {
    const clampedInitial = clampPageIndex(initialPage, null);
    lastPageRef.current = clampedInitial;
    lastPageFlipTimeRef.current = 0;
    fastFlipRef.current = false;
    if (fastFlipIdleTimerRef.current) {
      clearTimeout(fastFlipIdleTimerRef.current);
      fastFlipIdleTimerRef.current = null;
    }
    pendingScrollSizeRef.current = null;
    const timer = setTimeout(() => {
      clearCache();
      setPage(clampedInitial);
      setRenderPage(clampedInitial);
      setTotalPages(null);
      setPendingZoom(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [articleId, initialPage, clearCache]);

  useEffect(() => {
    if (totalPages == null) return;
    const timer = setTimeout(() => {
      setPage((current) => clampPageIndex(current, totalPages));
      setRenderPage((current) => clampPageIndex(current, totalPages));
    }, 0);
    return () => clearTimeout(timer);
  }, [totalPages]);

  useLayoutEffect(() => {
    scrollReaderToTop();
  }, [articleId, scrollReaderToTop]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const applyViewport = (width: number, height: number) => {
      const next = {
        articleId,
        width: Math.round(width),
        height: Math.round(height),
      };
      if (next.width < 1 || next.height < 1) return;

      const prev = viewportStateRef.current;
      if (!prev || prev.articleId !== articleId) {
        viewportStateRef.current = next;
        setViewport(next);
        return;
      }

      const dw = Math.abs(next.width - prev.width);
      const dh = Math.abs(next.height - prev.height);
      if (dw < VIEWPORT_SIZE_THRESHOLD && dh < VIEWPORT_SIZE_THRESHOLD) return;

      revokeObjectUrlMap(cacheRef.current);
      setUrl("");
      setImageSize(null);
      viewportStateRef.current = next;
      setViewport(next);
    };

    const measure = () => {
      const width = el.clientWidth;
      const height = Math.max(320, window.innerHeight - el.offsetTop);
      applyViewport(width, height);
    };

    measure();
    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(measure, 120);
    });
    observer.observe(el);
    window.addEventListener("resize", measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [articleId]);

  useLayoutEffect(() => {
    const updatePanelInsets = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPanelInsets({
        left: rect.left,
        right: window.innerWidth - rect.right,
      });
    };

    updatePanelInsets();
    const observer = new ResizeObserver(updatePanelInsets);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("resize", updatePanelInsets);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePanelInsets);
    };
  }, [articleId]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => revokeObjectUrlMap(cache);
  }, [articleId]);

  // 始终保留滚动条占位，避免滚动条显隐改变 viewport 宽度触发 ResizeObserver 重载
  useEffect(() => {
    const root = document.documentElement;
    const prevOverflowY = root.style.overflowY;
    root.style.overflowY = "scroll";
    return () => {
      root.style.overflowY = prevOverflowY;
    };
  }, [articleId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSliderZoom(zoom);
    }, 0);
    return () => clearTimeout(timer);
  }, [zoom]);

  useEffect(() => {
    return () => {
      if (zoomThrottleRef.current) clearTimeout(zoomThrottleRef.current);
      if (zoomSaveRef.current) clearTimeout(zoomSaveRef.current);
      if (fastFlipIdleTimerRef.current) {
        clearTimeout(fastFlipIdleTimerRef.current);
      }
    };
  }, []);

  const persistZoom = useCallback((nextZoom: number) => {
    if (zoomSaveRef.current) clearTimeout(zoomSaveRef.current);
    zoomSaveRef.current = setTimeout(() => {
      zoomSaveRef.current = null;
      updateReaderConfig({ zoom: nextZoom }).catch(() => {});
    }, ZOOM_SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { res, data } = await fetchReaderConfig();
      if (cancelled || !res.ok) return;
      setGrayscale("grayscale" in data ? !!data.grayscale : false);
      if ("zoom" in data && typeof data.zoom === "number") {
        const clamped = clampBlobReaderZoom(data.zoom);
        zoomRef.current = clamped;
        contextRef.current = { articleId, zoom: clamped };
        setZoom(clamped);
        setSliderZoom(clamped);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  useEffect(() => {
    if (!subscribeConfigEvents) return;
    return subscribeConfigEvents((evt) => {
      if (evt.key === USER_CONFIG.BLOB_READER_GRAYSCALE) {
        setGrayscale(parseBlobReaderGrayscale(evt.value));
      }
      if (evt.key === USER_CONFIG.BLOB_READER_ZOOM) {
        const clamped = parseBlobReaderZoom(evt.value);
        zoomRef.current = clamped;
        contextRef.current = { articleId, zoom: clamped };
        setZoom(clamped);
        setSliderZoom(clamped);
      }
    });
  }, [articleId, subscribeConfigEvents]);

  const toggleGrayscale = useCallback(() => {
    setGrayscale((prev) => {
      const next = !prev;
      updateReaderConfig({ grayscale: next }).catch(() => {});
      return next;
    });
  }, []);

  const preloadAndApplyUrl = useCallback(
    (nextUrl: string, onApplied: () => void, preserveScroll = false) => {
      const img = new window.Image();
      img.onload = () => {
        const size = bitmapToLayoutSize(img.naturalWidth, img.naturalHeight);
        pendingScrollSizeRef.current = { size, preserveScroll };
        setImageSize(size);
        setUrl(nextUrl);
        onApplied();
      };
      img.onerror = () => {
        pendingScrollSizeRef.current = null;
        setUrl(nextUrl);
        onApplied();
      };
      img.src = nextUrl;
    },
    [],
  );

  useLayoutEffect(() => {
    const pending = pendingScrollSizeRef.current;
    if (!pending || !url) return;
    pendingScrollSizeRef.current = null;
    if (pending.preserveScroll) {
      const cssZoomRatio = sliderZoomRef.current / zoomStateRef.current;
      restoreScrollFromSnapshot(pending.size.height * cssZoomRatio);
      return;
    }
    resetScrollPosition(pending.size);
  }, [url, resetScrollPosition, restoreScrollFromSnapshot]);

  useLayoutEffect(() => {
    if (!imageSize || Math.abs(sliderZoom - zoom) < 0.001) return;
    const pointAnchor = zoomPointAnchorRef.current;
    if (pointAnchor) {
      zoomPointAnchorRef.current = null;
      applyZoomPointAnchor(pointAnchor);
      return;
    }
    restoreScrollFromSnapshot(imageSize.height * (sliderZoom / zoom));
  }, [
    sliderZoom,
    zoom,
    imageSize,
    restoreScrollFromSnapshot,
    applyZoomPointAnchor,
  ]);

  useLayoutEffect(() => {
    if (!viewport || viewport.articleId !== articleId) return;

    const renderZoom = pendingZoom ?? zoom;
    zoomRef.current = renderZoom;
    const direction: "forward" | "backward" | "init" =
      renderPage > lastPageRef.current
        ? "forward"
        : renderPage < lastPageRef.current
          ? "backward"
          : "init";
    lastPageRef.current = renderPage;
    let cancelled = false;

    if (contextRef.current.articleId !== articleId) {
      revokeObjectUrlMap(cacheRef.current);
      inflightRef.current.clear();
      fetchQueueRef.current.reset();
    }
    contextRef.current = { articleId, zoom: renderZoom };

    const enqueueFetch = <T,>(
      task: () => Promise<T>,
      priority: number,
    ): Promise<T> => fetchQueueRef.current.enqueue(task, priority);

    const lookupCachedUrl = (targetPage: number) => {
      const vp = viewportStateRef.current;
      if (!vp || vp.articleId !== articleId) return null;
      const physical = getPhysicalSize(vp.width, vp.height, zoomRef.current);
      return (
        cacheRef.current.get(
          renderCacheKey(targetPage, physical.width, physical.height),
        ) ?? null
      );
    };

    const collectPreloadPages = () => {
      const vp = viewportStateRef.current;
      if (!vp || vp.articleId !== articleId) return [];
      const physical = getPhysicalSize(vp.width, vp.height, zoomRef.current);
      return getPreloadPages(renderPage, direction).filter((targetPage) => {
        const maxPages = totalPagesRef.current;
        if (maxPages != null && targetPage >= maxPages) return false;
        const key = renderCacheKey(targetPage, physical.width, physical.height);
        if (cacheRef.current.has(key)) return false;
        return !inflightRef.current.has(
          inflightPageKey(
            articleId,
            targetPage,
            physical.width,
            physical.height,
          ),
        );
      });
    };

    const fetchPage = async (
      targetPage: number,
      silent = false,
    ): Promise<string | null> => {
      const cached = lookupCachedUrl(targetPage);
      if (cached) return cached;

      const vp = viewportStateRef.current;
      if (!vp || vp.articleId !== articleId) {
        if (!silent) throw new Error("阅读区域未就绪");
        return null;
      }

      const currentZoom = zoomRef.current;
      const physical = getPhysicalSize(vp.width, vp.height, currentZoom);
      const flightKey = inflightPageKey(
        articleId,
        targetPage,
        physical.width,
        physical.height,
      );
      const pending = inflightRef.current.get(flightKey);
      if (pending) {
        const resolved = await pending.catch(() => null);
        return resolved ?? lookupCachedUrl(targetPage);
      }

      const fetchPromise = enqueueFetch(
        async () => {
          const res = await fetchArticleRender(token, articleId, {
            page: targetPage,
            width: physical.width,
            height: physical.height,
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(data.error || "渲染失败");
          }
          const blob = await res.blob();
          if (!blob.size) throw new Error("渲染结果为空");

          const numPagesHeader = res.headers.get("X-PDF-Num-Pages");
          if (numPagesHeader) {
            const numPages = Number.parseInt(numPagesHeader, 10);
            if (Number.isFinite(numPages) && numPages > 0) {
              setTotalPages(numPages);
            }
          }

          if (contextRef.current.articleId !== articleId) return null;
          if (contextRef.current.zoom !== currentZoom) return null;

          const key = renderCacheKey(
            targetPage,
            physical.width,
            physical.height,
          );
          const existing = cacheRef.current.get(key);
          if (existing) return existing;

          const objectUrl = URL.createObjectURL(blob);
          cacheRef.current.set(key, objectUrl);
          return objectUrl;
        },
        computeFetchPriority(targetPage, renderPage, !silent),
      );

      inflightRef.current.set(flightKey, fetchPromise);
      try {
        return await fetchPromise;
      } catch (err) {
        if (!silent) throw err;
        return null;
      } finally {
        inflightRef.current.delete(flightKey);
      }
    };

    const preloadNeighbors = () => {
      const pages = collectPreloadPages();
      if (!pages.length) return;
      for (const targetPage of pages) {
        if (cancelled) return;
        void fetchPage(targetPage, true);
      }
    };

    const showPage = (nextUrl: string) => {
      const preserveScroll =
        !!urlRef.current && direction === "init" && pendingZoom != null;

      const finish = () => {
        if (cancelled) return;
        setLoading(false);
        setError("");
        if (pendingZoom != null) {
          setZoom(renderZoom);
          setPendingZoom(null);
          const vp = viewportStateRef.current;
          if (vp && vp.articleId === articleId) {
            const physical = getPhysicalSize(vp.width, vp.height, renderZoom);
            pruneRenderCache(cacheRef.current, physical.width, physical.height);
          }
        }
        saveArticleProgress(articleId, renderPage).catch(() => {});
        preloadNeighbors();
      };

      if (preserveScroll) {
        captureCurrentScrollSnapshot();
      }

      preloadAndApplyUrl(nextUrl, finish, preserveScroll);
    };

    const showCachedPageOnly = (nextUrl: string) => {
      preloadAndApplyUrl(
        nextUrl,
        () => {
          if (cancelled) return;
          setLoading(false);
          setError("");
        },
        false,
      );
    };

    if (page !== renderPage) {
      const cachedWhileFlipping = lookupCachedUrl(page);
      if (cachedWhileFlipping) {
        showCachedPageOnly(cachedWhileFlipping);
      } else {
        setLoading(true);
        setError("");
      }
      return () => {
        cancelled = true;
      };
    }

    const cached = lookupCachedUrl(renderPage);
    if (cached) {
      showPage(cached);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      setLoading(true);
      setError("");
      try {
        const nextUrl = await fetchPage(renderPage);
        if (cancelled) return;
        if (!nextUrl) throw new Error("渲染结果为空");
        showPage(nextUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "渲染失败");
          setLoading(false);
          setPendingZoom(null);
          setSliderZoom(zoom);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    articleId,
    token,
    page,
    renderPage,
    zoom,
    pendingZoom,
    viewport,
    preloadAndApplyUrl,
    captureCurrentScrollSnapshot,
  ]);

  const queueRenderZoom = useCallback(
    (nextZoom: number) => {
      const clamped = clampBlobReaderZoom(nextZoom);
      persistZoom(clamped);
      if (Math.abs(clamped - zoom) < 0.001) {
        setPendingZoom(null);
        return;
      }
      setPendingZoom(clamped);
    },
    [zoom, persistZoom],
  );

  const scheduleZoom = useCallback(
    (nextZoom: number, options?: { captureScroll?: boolean }) => {
      const clamped = clampBlobReaderZoom(nextZoom);
      if (options?.captureScroll !== false) {
        captureCurrentScrollSnapshot();
      }
      setSliderZoom(clamped);
      if (zoomThrottleRef.current) clearTimeout(zoomThrottleRef.current);
      zoomThrottleRef.current = setTimeout(() => {
        zoomThrottleRef.current = null;
        queueRenderZoom(clamped);
      }, ZOOM_THROTTLE_MS);
    },
    [captureCurrentScrollSnapshot, queueRenderZoom],
  );

  const commitZoom = useCallback(
    (nextZoom: number) => {
      const clamped = clampBlobReaderZoom(nextZoom);
      if (zoomThrottleRef.current) {
        clearTimeout(zoomThrottleRef.current);
        zoomThrottleRef.current = null;
      }
      captureCurrentScrollSnapshot();
      setSliderZoom(clamped);
      queueRenderZoom(clamped);
    },
    [captureCurrentScrollSnapshot, queueRenderZoom],
  );

  useEffect(() => {
    scheduleZoomRef.current = scheduleZoom;
    commitZoomRef.current = commitZoom;
  }, [scheduleZoom, commitZoom]);

  const stepZoom = useCallback(
    (delta: number) => {
      commitZoom(sliderZoom + delta);
    },
    [sliderZoom, commitZoom],
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    let wheelCommitTimer: ReturnType<typeof setTimeout> | null = null;

    const applyPanDelta = (
      dx: number,
      dy: number,
      start: {
        startScrollLeft: number;
        startWindowScrollY: number;
      },
    ) => {
      const hScroll = hScrollRef.current;
      if (!hScroll) return;
      hScroll.scrollLeft = start.startScrollLeft - dx;
      window.scrollTo(0, start.startWindowScrollY - dy);
    };

    const finishPinch = () => {
      if (!pinchRef.current) return;
      pinchRef.current = null;
      commitZoomRef.current(sliderZoomRef.current);
    };

    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (el.hasPointerCapture(event.pointerId)) {
        el.releasePointerCapture(event.pointerId);
      }
      el.style.cursor = urlRef.current ? "grab" : "";
      el.style.userSelect = "";
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const hScroll = hScrollRef.current;
      if (!hScroll || !urlRef.current) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: hScroll.scrollLeft,
        startWindowScrollY: window.scrollY,
      };
      el.setPointerCapture(event.pointerId);
      el.style.cursor = "grabbing";
      el.style.userSelect = "none";
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      applyPanDelta(
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY,
        drag,
      );
      event.preventDefault();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const startDistance = touchDistance(event.touches);
      if (startDistance < 1) return;
      pinchRef.current = {
        startDistance,
        startZoom: sliderZoomRef.current,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current;
      if (pinch && event.touches.length >= 2) {
        event.preventDefault();
        const distance = touchDistance(event.touches);
        if (distance < 1) return;

        const hScroll = hScrollRef.current;
        const img = hScroll?.querySelector("img");
        if (!hScroll || !img) return;

        const imgRect = img.getBoundingClientRect();
        if (imgRect.width < 1 || imgRect.height < 1) return;

        const oldSliderZoom = sliderZoomRef.current;
        const nextSliderZoom = clampBlobReaderZoom(
          pinch.startZoom * (distance / pinch.startDistance),
        );
        if (Math.abs(nextSliderZoom - oldSliderZoom) < 0.0001) return;

        const center = touchCenter(event.touches);
        zoomPointAnchorRef.current = buildZoomPointAnchor(
          center.x,
          center.y,
          imgRect,
          nextSliderZoom / oldSliderZoom,
        );

        scheduleZoomRef.current(nextSliderZoom, { captureScroll: false });
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length >= 2) return;
      finishPinch();
    };

    const onWheel = (event: WheelEvent) => {
      const hScroll = hScrollRef.current;

      if (event.ctrlKey) {
        event.preventDefault();
        const img = hScroll?.querySelector("img");
        if (!hScroll || !img) return;

        const imgRect = img.getBoundingClientRect();
        if (imgRect.width < 1 || imgRect.height < 1) return;

        const oldSliderZoom = sliderZoomRef.current;
        const factor = Math.exp(-event.deltaY * 0.002);
        const nextSliderZoom = clampBlobReaderZoom(oldSliderZoom * factor);
        if (Math.abs(nextSliderZoom - oldSliderZoom) < 0.0001) return;

        const scale = nextSliderZoom / oldSliderZoom;
        zoomPointAnchorRef.current = buildZoomPointAnchor(
          event.clientX,
          event.clientY,
          imgRect,
          scale,
        );

        scheduleZoomRef.current(nextSliderZoom, { captureScroll: false });
        if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
        wheelCommitTimer = setTimeout(() => {
          wheelCommitTimer = null;
          commitZoomRef.current(sliderZoomRef.current);
        }, ZOOM_THROTTLE_MS);
        return;
      }

      if (!hScroll || !urlRef.current) return;

      const { deltaX, deltaY } = event;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (absY >= absX && absY > 0) {
        window.scrollBy({ top: deltaY, left: 0, behavior: "instant" });
        event.preventDefault();
        return;
      }

      if (absX > 0) {
        hScroll.scrollLeft += deltaX;
        event.preventDefault();
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", finishDrag);
    el.addEventListener("pointercancel", finishDrag);
    el.addEventListener("lostpointercapture", finishDrag);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finishDrag);
      el.removeEventListener("pointercancel", finishDrag);
      el.removeEventListener("lostpointercapture", finishDrag);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
      if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
      pinchRef.current = null;
      dragRef.current = null;
      zoomPointAnchorRef.current = null;
    };
  }, [articleId]);

  const floatingNavSx = {
    position: "fixed" as const,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 10,
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    boxShadow: 1,
    "&:hover": { bgcolor: "background.paper" },
  };

  const handleImageLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      setImageSize(bitmapToLayoutSize(img.naturalWidth, img.naturalHeight));
    },
    [],
  );

  const goToPage = useCallback((nextPage: number) => {
    const clamped = clampPageIndex(nextPage, totalPagesRef.current);
    const now = Date.now();
    const timeSinceLastFlip = now - lastPageFlipTimeRef.current;
    lastPageFlipTimeRef.current = now;

    setPage(clamped);

    if (timeSinceLastFlip < PAGE_FLIP_FAST_THRESHOLD_MS) {
      fastFlipRef.current = true;
    }

    if (fastFlipIdleTimerRef.current) {
      clearTimeout(fastFlipIdleTimerRef.current);
    }

    if (fastFlipRef.current) {
      fastFlipIdleTimerRef.current = setTimeout(() => {
        fastFlipIdleTimerRef.current = null;
        fastFlipRef.current = false;
        setRenderPage(pageRef.current);
      }, PAGE_FLIP_IDLE_MS);
      return;
    }

    setRenderPage(clamped);
  }, []);

  const openPageDialog = useCallback(() => {
    setPageInput(String(page + 1));
    setPageInputError("");
    setPageDialogOpen(true);
  }, [page]);

  const closePageDialog = useCallback(() => {
    setPageDialogOpen(false);
    setPageInputError("");
  }, []);

  const submitPageJump = useCallback(() => {
    const trimmed = pageInput.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!trimmed || !Number.isFinite(parsed) || parsed < 1) {
      setPageInputError("请输入有效页码");
      return;
    }
    if (totalPages != null && parsed > totalPages) {
      setPageInputError(`页码不能超过 ${totalPages}`);
      return;
    }
    goToPage(parsed - 1);
    closePageDialog();
  }, [pageInput, totalPages, goToPage, closePageDialog]);

  const pageLabel =
    totalPages != null ? `${page + 1} / ${totalPages}` : `${page + 1} / —`;
  const atLastPage = totalPages != null && page >= totalPages - 1;
  const cssZoomRatio = sliderZoom / zoom;
  const displayImageSize = imageSize
    ? {
        width: imageSize.width * cssZoomRatio,
        height: imageSize.height * cssZoomRatio,
      }
    : null;

  return (
    <Box
      ref={contentRef}
      sx={{
        bgcolor: "background.paper",
        position: "relative",
        width: "100%",
        minWidth: 0,
        overflowX: "hidden",
      }}
    >
      <Box
        sx={{
          position: "fixed",
          bottom: 20,
          left: panelInsets.left,
          right: panelInsets.right,
          zIndex: 15,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <Box
          sx={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1.5,
            py: 0.75,
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 3,
            boxShadow: 3,
            width: "fit-content",
            maxWidth: "calc(100% - 32px)",
          }}
        >
          <Button
            size="small"
            variant="text"
            onClick={openPageDialog}
            aria-label="跳转到页码"
            sx={{
              minWidth: 0,
              px: 0.75,
              py: 0.25,
              flexShrink: 0,
              fontWeight: 600,
              fontSize: "0.75rem",
              lineHeight: 1.66,
              color: "text.secondary",
              whiteSpace: "nowrap",
            }}
          >
            {pageLabel}
          </Button>
          <Tooltip title={`缩小 (${Math.round(sliderZoom * 100)}%)`}>
            <span>
              <IconButton
                size="small"
                disabled={sliderZoom <= ZOOM_MIN + 0.001}
                onClick={() => stepZoom(-ZOOM_STEP)}
                aria-label="缩小"
                sx={{ flexShrink: 0 }}
              >
                <ZoomOutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={`放大 (${Math.round(sliderZoom * 100)}%)`}>
            <span>
              <IconButton
                size="small"
                disabled={sliderZoom >= ZOOM_MAX - 0.001}
                onClick={() => stepZoom(ZOOM_STEP)}
                aria-label="放大"
                sx={{ flexShrink: 0 }}
              >
                <ZoomInIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={grayscale ? "关闭黑白滤镜" : "开启黑白滤镜"}>
            <IconButton
              size="small"
              onClick={toggleGrayscale}
              color={grayscale ? "primary" : "default"}
              aria-label="黑白滤镜"
              aria-pressed={grayscale}
              sx={{ flexShrink: 0 }}
            >
              {grayscale ? (
                <DarkModeIcon fontSize="small" />
              ) : (
                <DarkModeOutlinedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <IconButton
        size="medium"
        aria-label="上一页"
        disabled={page <= 0}
        onClick={() => goToPage(page - 1)}
        sx={{ ...floatingNavSx, left: panelInsets.left + 50 }}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="medium"
        aria-label="下一页"
        disabled={atLastPage}
        onClick={() => goToPage(page + 1)}
        sx={{ ...floatingNavSx, right: panelInsets.right + 16 }}
      >
        <ChevronRightIcon fontSize="small" />
      </IconButton>

      <Dialog
        open={pageDialogOpen}
        onClose={closePageDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>跳转到页码</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="页码"
            type="number"
            value={pageInput}
            onChange={(event) => {
              setPageInput(event.target.value);
              setPageInputError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitPageJump();
              }
            }}
            error={!!pageInputError}
            helperText={
              pageInputError ||
              (totalPages != null
                ? `请输入 1 至 ${totalPages} 之间的页码`
                : undefined)
            }
            inputProps={{
              min: 1,
              max: totalPages ?? undefined,
            }}
            sx={{ mt: 0.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closePageDialog}>取消</Button>
          <Button variant="contained" onClick={submitPageJump}>
            跳转
          </Button>
        </DialogActions>
      </Dialog>

      {loading && url && (
        <Box
          sx={{
            position: "fixed",
            top: 0,
            bottom: 0,
            left: panelInsets.left,
            right: panelInsets.right,
            bgcolor: "rgba(255,255,255,0.45)",
            zIndex: 8,
            pointerEvents: "none",
          }}
        />
      )}

      {loading && pendingZoom == null && (
        <Box
          sx={{
            position: "fixed",
            top: "50%",
            left: panelInsets.left,
            right: panelInsets.right,
            transform: "translateY(-50%)",
            zIndex: 12,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <CircularProgress size={24} />
        </Box>
      )}

      <Box
        ref={viewportRef}
        sx={{
          position: "relative",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          overflow: "hidden",
          minHeight: displayImageSize?.height,
          touchAction: url ? "pan-x pan-y" : "auto",
          cursor: url ? "grab" : "default",
        }}
      >
        {error && (
          <Typography
            variant="body2"
            color="error"
            sx={{ maxWidth: 720, mb: 1 }}
          >
            {error}
          </Typography>
        )}

        <Box
          ref={hScrollRef}
          sx={{
            width: "100%",
            maxWidth: "100%",
            overflowX: "auto",
            overflowY: "visible",
            scrollbarGutter: "stable",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              minWidth: "100%",
              width: "max-content",
            }}
          >
            {url ? (
              <Box sx={{ boxShadow: displayImageSize ? 3 : 0 }}>
                <Box
                  component="img"
                  src={url}
                  alt={title}
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                  onLoad={handleImageLoad}
                  sx={{
                    display: "block",
                    width: displayImageSize
                      ? `${displayImageSize.width}px`
                      : "auto",
                    height: displayImageSize
                      ? `${displayImageSize.height}px`
                      : "auto",
                    maxWidth: "none",
                    flexShrink: 0,
                    userSelect: "none",
                    WebkitUserDrag: "none",

                    bgcolor: "background.paper",
                    filter: grayscale
                      ? themeMode == "dark"
                        ? "grayscale(100%) invert(0.92)"
                        : "grayscale(100%)"
                      : "none",
                  }}
                />
              </Box>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
