import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Provider } from "@infini-scroll/core";
import { useInfini } from "@infini-scroll/react";
import type { BundleItem } from "@/shared/bundles/protocol";
import InfiniView from "@/client/components/shared/InfiniView";
import {
  fetchArticleBundleItems,
  materializeBundleItem,
  openArticleBundle,
  type MaterializedBundleItem,
} from "@/client/interact/bundles";
import { saveArticleProgress } from "@/client/interact/articles";
import { useDebugStore } from "@/client/hooks/useDebugStore";

const SAVE_DEBOUNCE_MS = 1500;
const PAGE_GAP = 24;
const ESTIMATED_PAGE_WIDTH = 900;

interface BundleCursor {
  ordinal: number;
}

const BUNDLE_OPS = {
  getId: (item: BundleItem) => item.id,
  getCursor: (item: BundleItem): BundleCursor => ({
    ordinal: item.ordinal,
  }),
};

function estimatePageHeight(item: BundleItem): number {
  return (
    Math.max(1, (item.height / item.width) * ESTIMATED_PAGE_WIDTH) + PAGE_GAP
  );
}

const BundlePage = React.memo(function BundlePage({
  articleId,
  item,
}: {
  articleId: string;
  item: BundleItem;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [page, setPage] = useState<MaterializedBundleItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setWidth(host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let materialized: MaterializedBundleItem | null = null;
    void materializeBundleItem(articleId, item)
      .then((value) => {
        if (disposed) {
          value.release();
          return;
        }
        materialized = value;
        setPage(value);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "页面加载失败");
        }
      });
    return () => {
      disposed = true;
      materialized?.release();
    };
  }, [articleId, item]);

  const postFramePage = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    const payload = page?.takeFramePayload();
    if (!frameWindow || !payload) return;
    frameWindow.postMessage(payload.message, "*", payload.transfer);
  }, [page]);

  useEffect(() => {
    const handleFrameMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; x?: unknown; y?: unknown };
      if (data?.type === "classapp:bundle-frame-bootstrap-ready") {
        postFramePage();
      } else if (data?.type === "classapp:bundle-frame-scroll") {
        const x =
          typeof data.x === "number" && Number.isFinite(data.x) ? data.x : 0;
        const y =
          typeof data.y === "number" && Number.isFinite(data.y) ? data.y : 0;
        window.scrollBy(
          Math.max(-2_000, Math.min(2_000, x)),
          Math.max(-2_000, Math.min(2_000, y)),
        );
      } else if (data?.type === "classapp:bundle-frame-error") {
        const message =
          "message" in data && typeof data.message === "string"
            ? data.message.slice(0, 500)
            : "页面载入失败";
        setError(message);
      }
    };
    window.addEventListener("message", handleFrameMessage);
    return () => window.removeEventListener("message", handleFrameMessage);
  }, [postFramePage]);

  const scale = width > 0 ? width / item.width : 1;
  const height = Math.max(1, item.height * scale);
  return (
    <Box
      ref={hostRef}
      data-infini-id={item.id}
      sx={{
        width: "100%",
        maxWidth: `${item.width}px`,
        mx: "auto",
        mb: `${PAGE_GAP}px`,
        height: `${height}px`,
        position: "relative",
        overflow: "hidden",
        bgcolor: "common.white",
        boxShadow: 3,
      }}
    >
      {page && !error ? (
        <iframe
          ref={iframeRef}
          title={`文档第 ${item.ordinal + 1} 页`}
          sandbox="allow-scripts"
          srcDoc={page.srcDoc}
          onLoad={postFramePage}
          scrolling="no"
          style={{
            display: "block",
            border: 0,
            width: `${item.width}px`,
            height: `${item.height}px`,
            transform: `scale(${scale})`,
            transformOrigin: "left top",
          }}
        />
      ) : (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: error ? "error.main" : "text.disabled",
          }}
        >
          <Typography variant="caption">
            {error ?? `正在准备第 ${item.ordinal + 1} 页…`}
          </Typography>
        </Box>
      )}
    </Box>
  );
});

interface BundleArticleReaderProps {
  articleId: string;
  itemCount: number;
  initialItem: number;
  paddingStart: number;
  online: boolean;
  onProgressChange?: (ordinal: number) => void;
}

export default function BundleArticleReader({
  articleId,
  itemCount,
  initialItem,
  paddingStart,
  online,
  onProgressChange,
}: BundleArticleReaderProps) {
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  const [bootstrapOrdinal] = useState(() =>
    Math.max(0, Math.min(initialItem, Math.max(0, itemCount - 1))),
  );
  const onlineRef = useRef(online);
  const previousOnlineRef = useRef(online);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVisibleRef = useRef(bootstrapOrdinal);
  const lastSavedRef = useRef(-1);
  const [offlineBoundaryBefore, setOfflineBoundaryBefore] = useState(false);
  const [offlineBoundaryAfter, setOfflineBoundaryAfter] = useState(false);

  useLayoutEffect(() => {
    onlineRef.current = online;
  }, [online]);

  const provider: Provider<BundleItem, BundleCursor, string> = {
    async bootstrap({ cursor, signal }) {
      const slice = await openArticleBundle(
        articleId,
        cursor?.ordinal ?? bootstrapOrdinal,
      );
      if (signal.aborted) throw new Error("Bundle bootstrap superseded");
      if (!slice) throw new Error("Bundle 不可用");
      return {
        items: slice.items,
        exhaustedBefore: slice.exhausted_before,
        exhaustedAfter: slice.exhausted_after,
      };
    },
    async fetch({ cursor, direction, signal }) {
      const slice = await fetchArticleBundleItems(
        articleId,
        cursor.ordinal,
        direction,
      );
      if (signal.aborted) throw new Error("Bundle fetch superseded");
      if (!slice) throw new Error("Bundle 不可用");
      if (!slice.items.length && !onlineRef.current) {
        if (direction === "before") setOfflineBoundaryBefore(true);
        else setOfflineBoundaryAfter(true);
      }
      return {
        items: slice.items,
        exhaustedBefore:
          slice.exhausted_before ||
          (!onlineRef.current && direction === "before" && !slice.items.length),
        exhaustedAfter:
          slice.exhausted_after ||
          (!onlineRef.current && direction === "after" && !slice.items.length),
      };
    },
    async locateOffset({ anchor, signedItemOffset }) {
      const ordinal = Math.max(
        0,
        Math.min(itemCount - 1, anchor.ordinal + signedItemOffset),
      );
      return { cursor: { ordinal }, targetId: `page:${ordinal + 1}` };
    },
  };

  const { controller, snapshot } = useInfini<
    BundleItem,
    BundleCursor,
    string,
    number
  >({
    debug: showInfiniLogs ? "BundleArticleReader" : undefined,
    onError: (error, context) => {
      console.error(
        "[BundleArticleReader] Infini provider failed",
        context,
        error,
      );
    },
    provider,
    ops: BUNDLE_OPS,
    estimateSize: estimatePageHeight,
    initial: {
      cursor: { ordinal: bootstrapOrdinal },
      target: bootstrapOrdinal,
      alignment: "start",
    },
    targetToCursor: (ordinal) => ({ ordinal }),
    locateTarget: (items, ordinal) =>
      items.find((item) => item.ordinal === ordinal)?.id ?? null,
    residentBefore: 2,
    residentAfter: 2,
    defaultItemEstimate: estimatePageHeight({
      id: "estimate",
      ordinal: 0,
      width: 816,
      height: 1056,
      document: "0".repeat(64),
      dependencies: [],
    }),
  });

  const visibleOrdinal =
    controller.getVisibleItem(0.08)?.item.ordinal ?? bootstrapOrdinal;

  const persistProgress = useCallback(
    (ordinal: number) => {
      if (ordinal === lastSavedRef.current) return;
      lastSavedRef.current = ordinal;
      saveArticleProgress(articleId, ordinal)
        .then(() => onProgressChange?.(ordinal))
        .catch(() => {});
    },
    [articleId, onProgressChange],
  );

  useEffect(() => {
    if (snapshot.phase.status === "bootstrapping") return;
    lastVisibleRef.current = visibleOrdinal;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persistProgress(visibleOrdinal);
    }, SAVE_DEBOUNCE_MS);
  }, [persistProgress, snapshot.phase.status, visibleOrdinal]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      persistProgress(lastVisibleRef.current);
    },
    [persistProgress],
  );

  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    previousOnlineRef.current = online;
    if (!online || wasOnline) return;
    setOfflineBoundaryBefore(false);
    setOfflineBoundaryAfter(false);
    controller.reopen("before");
    controller.reopen("after");
  }, [controller, online]);

  const boundary = (label: string) => (
    <Box sx={{ textAlign: "center", py: 2 }}>
      <Typography variant="caption" color="text.disabled">
        —— {label} ——
      </Typography>
    </Box>
  );

  return (
    <InfiniView
      controller={controller}
      snapshot={snapshot}
      renderItem={(item) => <BundlePage articleId={articleId} item={item} />}
      beforeLabel="加载前页"
      afterLabel="加载后页"
      onRetry={() => controller.retry()}
      paddingStart={paddingStart}
      layoutBefore={8_000}
      layoutAfter={8_000}
      anchorRatio={0.08}
      rootSx={{ px: { xs: 1, sm: 2 }, py: 2, bgcolor: "grey.900" }}
      header={
        !online && offlineBoundaryBefore ? boundary("以上页面未下载") : null
      }
      footer={
        !online && offlineBoundaryAfter
          ? boundary("以下页面未下载")
          : snapshot.exhaustedAfter && snapshot.mainLength > 0
            ? boundary(`文档完（共 ${itemCount} 页）`)
            : null
      }
    />
  );
}
