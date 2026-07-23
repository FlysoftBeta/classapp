import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import CircularProgress from "@mui/material/CircularProgress";
import Popover from "@mui/material/Popover";
import type { PopoverActions } from "@mui/material/Popover";
import EmojiEmotionsIcon from "@mui/icons-material/EmojiEmotions";
import type { UserConfigChangedEvent } from "@/client/hooks/useAppLogic";
import type { StickerPackSummary, StickerRecentItem } from "@/shared/types/api";
import { Infini2List, useInfini2, type Infini2Provider } from "@/lib/infini2";
import {
  fetchRecentStickers,
  fetchStickerPack,
  fetchStickerPacks,
} from "@/client/api/stickers";
import { lbAssetUrl } from "@/client/lib/loadBalancer";
import Tooltip from "@mui/material/Tooltip";
import { InfiniId } from "@/client/components/debug/InfiniId";
import { useDebugStore } from "@/client/store/debugStore";

const PICKER_WIDTH = 320;
const STICKER_CELL = 72;
const GRID_GAP = 4;
const GRID_COLUMNS = 4;
const ROW_HEIGHT = STICKER_CELL + GRID_GAP;

interface StickerPickerProps {
  disabled?: boolean;
  onPick: (item: StickerRecentItem) => void;
  subscribeConfigEvents?: (
    fn: (evt: UserConfigChangedEvent) => void,
  ) => () => void;
}

interface StickerGridRow {
  id: string;
  index: number;
  items: StickerRecentItem[];
}

function chunkStickerRows(items: StickerRecentItem[]): StickerGridRow[] {
  const rows: StickerGridRow[] = [];
  for (let index = 0; index < items.length; index += GRID_COLUMNS) {
    const rowItems = items.slice(index, index + GRID_COLUMNS);
    rows.push({
      id: rowItems.map((item) => `${item.pack}:${item.id}`).join("|"),
      index: rows.length,
      items: rowItems,
    });
  }
  return rows;
}

const StickerRow = React.memo(function StickerRow({
  row,
  onPick,
}: {
  row: StickerGridRow;
  onPick: (item: StickerRecentItem) => void;
}) {
  return (
    <Box
      data-infini-id={row.id}
      sx={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gap: `${GRID_GAP}px`,
        pb: `${GRID_GAP}px`,
      }}
    >
      {row.items.map((item) => (
        <Box
          key={`${item.pack}:${item.id}`}
          component="button"
          type="button"
          onClick={() => onPick(item)}
          sx={{
            border: "none",
            bgcolor: "transparent",
            p: 0.5,
            borderRadius: 1,
            cursor: "pointer",
            minWidth: 0,
            overflow: "hidden",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <InfiniId id={item.id} />
          <Box
            component="img"
            src={lbAssetUrl(item.path)}
            alt={item.name}
            loading="lazy"
            sx={{
              width: STICKER_CELL - 8,
              height: STICKER_CELL - 8,
              objectFit: "contain",
              display: "block",
              mx: "auto",
            }}
          />
        </Box>
      ))}
    </Box>
  );
});

function StickerVirtualGrid({
  items,
  onPick,
}: {
  items: StickerRecentItem[];
  onPick: (item: StickerRecentItem) => void;
}) {
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  const rows = useMemo(() => chunkStickerRows(items), [items]);
  const [scrollHost, setScrollHost] = useState<HTMLDivElement | null>(null);
  const provider = useMemo<Infini2Provider<StickerGridRow, number, string>>(
    () => ({
      async bootstrap() {
        return {
          items: rows,
          exhaustedBefore: true,
          exhaustedAfter: true,
        };
      },
      async fetch() {
        return {
          items: [],
          exhaustedBefore: true,
          exhaustedAfter: true,
        };
      },
    }),
    [rows],
  );
  const { controller } = useInfini2<StickerGridRow, number, string>({
    debug: import.meta.env.DEV && showInfiniLogs ? "StickerPicker" : undefined,
    provider,
    ops: {
      getId: (row) => row.id,
      getCursor: (row) => row.index,
    },
    estimateSize: () => ROW_HEIGHT,
    defaultItemEstimate: ROW_HEIGHT,
    initial: { cursor: null, alignment: "start" },
    residentBefore: 2,
    residentAfter: 2,
  });

  return (
    <Box
      ref={setScrollHost}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflowY: "auto",
        overflowX: "hidden",
        p: 1,
        overflowAnchor: "none",
      }}
    >
      {scrollHost ? (
        <Infini2List
          controller={controller}
          scrollHost={scrollHost}
          renderItem={(row) => <StickerRow row={row} onPick={onPick} />}
          layoutBefore={ROW_HEIGHT * 3}
          layoutAfter={ROW_HEIGHT * 3}
          anchorRatio={0}
        />
      ) : null}
    </Box>
  );
}

export function StickerPicker({
  disabled,
  onPick,
  subscribeConfigEvents,
}: StickerPickerProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);
  const popoverActionRef = useRef<PopoverActions>(null);
  const popoverResizeObserverRef = useRef<ResizeObserver | null>(null);
  const popoverPositionFrameRef = useRef<number | null>(null);

  const schedulePopoverPosition = useCallback(() => {
    if (popoverPositionFrameRef.current != null) {
      cancelAnimationFrame(popoverPositionFrameRef.current);
    }
    popoverPositionFrameRef.current = requestAnimationFrame(() => {
      popoverPositionFrameRef.current = null;
      popoverActionRef.current?.updatePosition();
    });
  }, []);

  const handlePopoverPaperRef = useCallback(
    (paper: HTMLDivElement | null) => {
      popoverResizeObserverRef.current?.disconnect();
      popoverResizeObserverRef.current = null;
      if (!paper) return;
      const observer = new ResizeObserver(schedulePopoverPosition);
      observer.observe(paper);
      popoverResizeObserverRef.current = observer;
      schedulePopoverPosition();
    },
    [schedulePopoverPosition],
  );

  const [packs, setPacks] = useState<StickerPackSummary[]>([]);
  const [recent, setRecent] = useState<StickerRecentItem[]>([]);
  const [tab, setTab] = useState(0);
  const [packStickers, setPackStickers] = useState<StickerRecentItem[]>([]);
  const [loadingPack, setLoadingPack] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    try {
      const [packRes, recentRes] = await Promise.all([
        fetchStickerPacks(),
        fetchRecentStickers(),
      ]);
      if (packRes.res.ok && "packs" in packRes.data && packRes.data.packs) {
        setPacks(packRes.data.packs);
      }
      if (
        recentRes.res.ok &&
        "recent" in recentRes.data &&
        recentRes.data.recent
      ) {
        setRecent(recentRes.data.recent);
      }
    } finally {
      setLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void loadMeta();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, loadMeta]);

  useEffect(() => {
    if (!subscribeConfigEvents) return;
    return subscribeConfigEvents((evt) => {
      if (evt.key !== "recent_stickers") return;
      void fetchRecentStickers().then(({ res, data }) => {
        if (res.ok && "recent" in data && data.recent) setRecent(data.recent);
      });
    });
  }, [subscribeConfigEvents]);

  const activePack = tab === 0 ? null : (packs[tab - 1] ?? null);

  useEffect(() => {
    if (!open || !activePack) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setLoadingPack(true);
        setPackStickers([]);
        try {
          const { res, data } = await fetchStickerPack(activePack.id);
          if (cancelled) return;
          if (res.ok && "pack" in data && data.pack) {
            const pack = data.pack;
            const items = Object.entries(pack.stickers).map(
              ([id, sticker]) => ({
                pack: pack.id,
                id,
                name: sticker.name,
                path: sticker.path,
              }),
            );
            items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
            setPackStickers(items);
          } else {
            setPackStickers([]);
          }
        } finally {
          if (!cancelled) setLoadingPack(false);
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, activePack]);

  const gridItems = tab === 0 ? recent : packStickers;
  const gridKey = gridItems.map((item) => `${item.pack}:${item.id}`).join("|");
  const loading = (loadingMeta && tab === 0) || (loadingPack && tab > 0);

  useEffect(() => {
    return () => {
      popoverResizeObserverRef.current?.disconnect();
      if (popoverPositionFrameRef.current != null) {
        cancelAnimationFrame(popoverPositionFrameRef.current);
      }
    };
  }, []);

  const handlePick = (item: StickerRecentItem) => {
    onPick(item);
    setRecent((prev) => {
      const filtered = prev.filter(
        (x) => !(x.pack === item.pack && x.id === item.id),
      );
      return [item, ...filtered].slice(0, 32);
    });
    setAnchorEl(null);
  };

  return (
    <>
      <Tooltip title="表情">
        <IconButton
          size="small"
          disabled={disabled}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{ mb: 0.5, mr: 0.5 }}
        >
          <EmojiEmotionsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        action={popoverActionRef}
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            ref: handlePopoverPaperRef,
            sx: {
              width: PICKER_WIDTH,
              maxHeight: 360,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            },
          },
        }}
      >
        <Tabs
          value={tab}
          onChange={(_, v: number) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{
            minHeight: 40,
            borderBottom: 1,
            borderColor: "divider",
            flexShrink: 0,
            minWidth: 0,
            "& .MuiTabs-scroller": {
              scrollbarWidth: "none",
              msOverflowStyle: "none",
              "&::-webkit-scrollbar": { display: "none" },
            },
          }}
        >
          <Tab label="最近" sx={{ minHeight: 40, py: 0.5, minWidth: 56 }} />
          {packs.map((p) => (
            <Tab
              key={p.id}
              label={p.name}
              sx={{ minHeight: 40, py: 0.5, minWidth: 56, maxWidth: 120 }}
            />
          ))}
        </Tabs>
        {loading ? (
          <Box
            sx={{ display: "flex", justifyContent: "center", py: 3, flex: 1 }}
          >
            <CircularProgress size={24} />
          </Box>
        ) : gridItems.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ py: 3, textAlign: "center" }}
          >
            {tab === 0 ? "暂无最近使用的贴纸" : "此贴纸包为空"}
          </Typography>
        ) : (
          <StickerVirtualGrid
            key={gridKey}
            items={gridItems}
            onPick={handlePick}
          />
        )}
      </Popover>
    </>
  );
}
