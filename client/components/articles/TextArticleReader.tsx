import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Infini2View from "@/client/components/shared/Infini2View";
import {
  fetchArticleSegment,
  saveArticleProgress,
} from "@/client/api/articles";
import {
  type ClientTextChunk,
  chunkEnd,
  createChunkStore,
} from "@/client/lib/reader/textChunks";
import { useInfini2, type Infini2Provider } from "@/lib/infini2";
import { InfiniId } from "@/client/components/debug/InfiniId";
import { useDebugStore } from "@/client/hooks/useDebugStore";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 1500;
const ESTIMATE_LINE_HEIGHT = 15.2 * 1.9;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampOffset(offset: number, contentLength: number): number {
  return Math.max(0, Math.min(offset, contentLength));
}

function estimateChunkHeight(chunk: ClientTextChunk): number {
  const charsPerLine = 28;
  const lines = Math.ceil(chunk.content.length / charsPerLine);
  return Math.max(ESTIMATE_LINE_HEIGHT, lines * ESTIMATE_LINE_HEIGHT);
}

interface TextCursor {
  start: number;
  end: number;
}

const TEXT_OPS = {
  getId: (chunk: ClientTextChunk) => chunk.offset,
  getCursor: (chunk: ClientTextChunk): TextCursor => ({
    start: chunk.offset,
    end: chunkEnd(chunk),
  }),
};

// ---------------------------------------------------------------------------
// ChunkRow
// ---------------------------------------------------------------------------

const ChunkRow = React.memo(function ChunkRow({
  chunk,
}: {
  chunk: ClientTextChunk;
}) {
  return (
    <Box
      data-infini-id={chunk.offset}
      sx={{
        width: "100%",
      }}
    >
      <Typography
        component="div"
        variant="body2"
        sx={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.9,
          fontSize: "0.95rem",
          py: "10px",
        }}
      >
        <InfiniId id={chunk.offset} />
        {chunk.content}
      </Typography>
    </Box>
  );
});

// ---------------------------------------------------------------------------
// TextArticleReader
// ---------------------------------------------------------------------------

interface TextArticleReaderProps {
  articleId: string;
  contentLength: number;
  initialOffset: number;
  paddingStart: number;
  online: boolean;
  onProgressChange?: (offset: number) => void;
}

export default function TextArticleReader({
  articleId,
  contentLength: metaContentLength,
  initialOffset,
  paddingStart,
  online,
  onProgressChange,
}: TextArticleReaderProps) {
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  // `initialOffset` is restoration input, not a controlled reading position.
  // Progress persistence updates the parent and can feed a newer value back
  // while this keyed reader is mounted; consuming that value again would reset
  // the Infini controller after every save.
  const [bootstrapOffset] = useState(() =>
    clampOffset(initialOffset, metaContentLength),
  );

  // ---- Dynamic contentLength (API may return a larger value) ----
  const [liveContentLength, setLiveContentLength] = useState(metaContentLength);
  const [offlineBoundaryBefore, setOfflineBoundaryBefore] = useState(false);
  const [offlineBoundaryAfter, setOfflineBoundaryAfter] = useState(false);
  const contentLengthRef = useRef(metaContentLength);
  useLayoutEffect(() => {
    contentLengthRef.current = Math.max(
      contentLengthRef.current,
      liveContentLength,
      metaContentLength,
    );
  }, [liveContentLength, metaContentLength]);

  const actualContentLength = Math.max(metaContentLength, liveContentLength);

  // ---- Reading position persistence ----
  const lastSavedIdRef = useRef(-1);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const previousOnlineRef = useRef(online);
  const onlineRef = useRef(online);

  useLayoutEffect(() => {
    onlineRef.current = online;
  }, [online]);

  const persistProgress = useCallback(
    (offset: number) => {
      const clamped = clampOffset(offset, contentLengthRef.current);
      if (clamped === lastSavedIdRef.current) return;
      lastSavedIdRef.current = clamped;
      saveArticleProgress(articleId, clamped)
        .then(() => onProgressChange?.(clamped))
        .catch(() => {});
    },
    [articleId, onProgressChange],
  );

  const fetchSegment = useCallback(
    async (offset: number) => {
      const data = await fetchArticleSegment(articleId, offset);
      if (
        data?.content_length != null &&
        data.content_length > contentLengthRef.current
      ) {
        contentLengthRef.current = data.content_length;
        setLiveContentLength(data.content_length);
      }
      return data;
    },
    [articleId],
  );

  // Keep the chunk store for the lifetime of this reader. It owns the
  // cross-segment tail and the already fetched before/after chunks; creating
  // it inside the provider methods loses both whenever Infini2 fetches an
  // adjacent page.
  const chunkStoreRef = useRef<ReturnType<typeof createChunkStore> | null>(
    null,
  );
  const getChunkStore = useCallback(() => {
    if (!chunkStoreRef.current) {
      chunkStoreRef.current = createChunkStore(fetchSegment);
    }
    return chunkStoreRef.current;
  }, [fetchSegment]);

  const requestedChunkCount = (targetSize: number) =>
    Math.min(64, Math.max(12, Math.ceil(targetSize / ESTIMATE_LINE_HEIGHT)));

  const provider: Infini2Provider<ClientTextChunk, TextCursor, number> = {
    async bootstrap({ cursor, targetSize, signal }) {
      const anchor = clampOffset(
        cursor?.start ?? bootstrapOffset,
        contentLengthRef.current,
      );
      if (contentLengthRef.current === 0) {
        return { items: [], exhaustedBefore: true, exhaustedAfter: true };
      }
      const wanted = requestedChunkCount(targetSize);
      const chunks = await getChunkStore().bootstrap(
        anchor,
        wanted,
        Math.ceil(wanted * 0.4),
        contentLengthRef.current,
      );
      if (signal.aborted)
        throw new Error("article bootstrap request superseded");
      if (!chunks.length) throw new Error("article bootstrap returned no text");
      return {
        items: chunks,
        exhaustedBefore: chunks[0]!.offset <= 0,
        exhaustedAfter:
          chunkEnd(chunks[chunks.length - 1]!) >= contentLengthRef.current,
      };
    },
    async fetch({ cursor, direction, targetSize, signal }) {
      const wanted = requestedChunkCount(targetSize);
      if (direction === "before") {
        const result = await getChunkStore().takeBefore(
          cursor.start,
          wanted,
          contentLengthRef.current,
        );
        if (signal.aborted)
          throw new Error("article before request superseded");
        if (!result.chunks.length && cursor.start > 0) {
          if (onlineRef.current)
            throw new Error("article before request returned no text");
          setOfflineBoundaryBefore(true);
        }
        return {
          items: result.chunks,
          exhaustedBefore:
            result.chunks[0]?.offset === 0 ||
            (!onlineRef.current && result.chunks.length === 0),
          exhaustedAfter: false,
        };
      }
      const result = await getChunkStore().takeAfter(
        cursor.end,
        wanted,
        contentLengthRef.current,
      );
      if (signal.aborted) throw new Error("article after request superseded");
      if (!result.chunks.length && cursor.end < contentLengthRef.current) {
        if (onlineRef.current)
          throw new Error("article after request returned no text");
        setOfflineBoundaryAfter(true);
      }
      return {
        items: result.chunks,
        exhaustedBefore: false,
        exhaustedAfter:
          result.chunks.length > 0
            ? chunkEnd(result.chunks[result.chunks.length - 1]!) >=
              contentLengthRef.current
            : cursor.end >= contentLengthRef.current || !onlineRef.current,
      };
    },
    async locateOffset({ anchor, signedItemOffset }) {
      const averageChars = Math.max(1, anchor.content.length);
      const target = clampOffset(
        anchor.offset + signedItemOffset * averageChars,
        Math.max(0, contentLengthRef.current - 1),
      );
      return {
        cursor: { start: target, end: target },
        targetId: target,
      };
    },
  };

  const { controller, snapshot } = useInfini2<
    ClientTextChunk,
    TextCursor,
    number,
    number
  >({
    debug: showInfiniLogs ? "TextArticleReader" : undefined,
    onError: (error, context) => {
      console.error(
        "[TextArticleReader] Infini2 provider failed",
        context,
        error,
      );
    },
    provider,
    ops: TEXT_OPS,
    estimateSize: estimateChunkHeight,
    initial: {
      cursor: { start: bootstrapOffset, end: bootstrapOffset },
      target: bootstrapOffset,
      alignment: "center",
    },
    targetToCursor: (offset) => ({ start: offset, end: offset }),
    locateTarget: (chunks, offset) =>
      chunks.find((chunk) => chunk.offset <= offset && chunkEnd(chunk) > offset)
        ?.offset ?? null,
    residentBefore: 3,
    residentAfter: 3,
    defaultItemEstimate: ESTIMATE_LINE_HEIGHT,
  });

  const waterlineId = controller.getVisibleItem(0)?.id ?? null;

  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    previousOnlineRef.current = online;
    if (!online || wasOnline) return;
    const frame = requestAnimationFrame(() => {
      setOfflineBoundaryBefore(false);
      setOfflineBoundaryAfter(false);
      controller.reopen("before");
      controller.reopen("after");
    });
    return () => cancelAnimationFrame(frame);
  }, [online, controller]);

  // ---- Progress saving (uses waterlineId from the hook) ----
  useEffect(() => {
    if (snapshot.phase.status === "bootstrapping") return;
    if (waterlineId == null) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persistProgress(waterlineId);
    }, SAVE_DEBOUNCE_MS);
  }, [waterlineId, snapshot.phase.status, persistProgress]);

  // Save progress on unmount.
  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Save the last known waterline position.
      if (lastSavedIdRef.current >= 0) {
        persistProgress(lastSavedIdRef.current);
      }
    },
    [persistProgress],
  );

  const showEndIndicator =
    snapshot.exhaustedAfter &&
    snapshot.mainLength > 0 &&
    snapshot.phase.status !== "bootstrapping";
  const boundary = (text: string) => (
    <Box sx={{ textAlign: "center", py: 2 }}>
      <Typography variant="caption" color="text.disabled">
        —— {text} ——
      </Typography>
    </Box>
  );

  return (
    <Infini2View
      controller={controller}
      snapshot={snapshot}
      renderItem={(chunk) => <ChunkRow chunk={chunk} />}
      className="app-selectable"
      rootSx={{
        px: { xs: 2, sm: 4, md: 6 },
        py: 2,
        position: "relative",
      }}
      beforeLabel="加载上文"
      afterLabel="加载下文"
      onRetry={() => controller.retry()}
      paddingStart={paddingStart}
      layoutBefore={10_000}
      layoutAfter={10_000}
      anchorRatio={0}
      header={
        !online && offlineBoundaryBefore ? boundary("以上内容未下载") : null
      }
      footer={
        !online && offlineBoundaryAfter ? (
          boundary("以下内容未下载")
        ) : showEndIndicator ? (
          <Box sx={{ textAlign: "center", py: 3 }}>
            <Typography variant="caption" color="text.disabled">
              —— 全文完（共 {actualContentLength.toLocaleString()} 字）——
            </Typography>
          </Box>
        ) : null
      }
    />
  );
}
