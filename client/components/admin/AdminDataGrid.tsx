import { useMemo, useState, type ReactNode, type UIEvent } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import MoreVertIcon from "@mui/icons-material/MoreVert";

export interface AdminGridColumn<Row> {
  id: string;
  label: ReactNode;
  width: number;
  render: (row: Row) => ReactNode;
  hiddenByDefault?: boolean;
  hideable?: boolean;
  pinned?: "start" | "end";
  longText?: (row: Row) => string | null | undefined;
}

export function AdminDataGrid<Row>({
  rows,
  columns,
  rowKey,
  onRowClick,
  height = 520,
  empty = "暂无数据",
  selection,
  bulkActionBar,
}: {
  rows: readonly Row[];
  columns: readonly AdminGridColumn<Row>[];
  rowKey: (row: Row) => string | number;
  onRowClick?: (row: Row) => void;
  height?: number;
  empty?: ReactNode;
  selection?: {
    selectedKeys: ReadonlySet<string | number>;
    onChange: (keys: Set<string | number>) => void;
    isRowSelectable?: (row: Row) => boolean;
  };
  bulkActionBar?: ReactNode;
}) {
  const [hidden, setHidden] = useState(
    () =>
      new Set(
        columns
          .filter((column) => column.hiddenByDefault)
          .map((column) => column.id),
      ),
  );
  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    columnId: string;
  } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [expanded, setExpanded] = useState<{
    title: ReactNode;
    text: string;
  } | null>(null);
  const visible = useMemo(
    () => columns.filter((column) => !hidden.has(column.id)),
    [columns, hidden],
  );
  const rowHeight = 44;
  const overscan = 6;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(height / rowHeight) + overscan * 2;
  const end = Math.min(rows.length, start + count);
  const selectableRows = selection
    ? rows.filter((row) => selection.isRowSelectable?.(row) !== false)
    : [];
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((row) => selection?.selectedKeys.has(rowKey(row)));
  const someSelected = selectableRows.some((row) =>
    selection?.selectedKeys.has(rowKey(row)),
  );
  const selectionWidth = selection ? 42 : 0;
  const template = [
    ...(selection ? [`${selectionWidth}px`] : []),
    ...visible.map((column) => `${column.width}px`),
  ].join(" ");
  const contentWidth = visible.reduce(
    (total, column) => total + column.width,
    selectionWidth,
  );

  const pinnedStyle = (column: AdminGridColumn<Row>, header = false) => {
    const pin =
      column.pinned ??
      (column.id === columns[0]?.id
        ? "start"
        : column.id === "actions"
          ? "end"
          : undefined);
    if (pin === "end") {
      return {
        position: "sticky" as const,
        right: 0,
        zIndex: header ? 8 : 3,
        bgcolor: "background.paper",
        boxShadow: "-2px 0 4px rgba(0,0,0,0.08)",
      };
    }
    if (pin === "start") {
      return {
        position: "sticky" as const,
        left: selectionWidth,
        zIndex: header ? 7 : 2,
        bgcolor: "background.paper",
        boxShadow: "2px 0 4px rgba(0,0,0,0.08)",
      };
    }
    return {};
  };

  const cell = (column: AdminGridColumn<Row>, row: Row) => {
    const text = column.longText?.(row);
    return (
      <Box
        key={column.id}
        onClick={
          text
            ? (event) => {
                event.stopPropagation();
                setExpanded({ title: column.label, text });
              }
            : undefined
        }
        title={text ? "点击展开完整内容" : undefined}
        sx={{
          minWidth: 0,
          px: 1.25,
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
          borderRight: "1px solid",
          borderColor: "divider",
          ...pinnedStyle(column),
          ...(text && { cursor: "zoom-in" }),
        }}
      >
        <Box
          sx={{
            minWidth: 0,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {column.render(row)}
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{ position: "relative" }}>
      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        <Typography variant="overline" sx={{ px: 2, color: "text.secondary" }}>
          显示列
        </Typography>
        {columns.map((column) => (
          <MenuItem
            key={column.id}
            dense
            disabled={
              column.hideable === false ||
              column.pinned === "start" ||
              column.id === columns[0]?.id
            }
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(column.id)) next.delete(column.id);
                else next.add(column.id);
                return next;
              })
            }
          >
            <ListItemIcon>
              <Checkbox
                size="small"
                checked={!hidden.has(column.id)}
                tabIndex={-1}
                disableRipple
              />
            </ListItemIcon>
            <ListItemText>{column.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>

      <Box
        role="table"
        onScroll={(event: UIEvent<HTMLDivElement>) =>
          setScrollTop(event.currentTarget.scrollTop)
        }
        sx={{
          height,
          maxHeight: "65vh",
          overflow: "auto",
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1.5,
          position: "relative",
        }}
      >
        <Box
          role="row"
          sx={{
            position: "sticky",
            top: 0,
            zIndex: 5,
            display: "grid",
            gridTemplateColumns: template,
            width: contentWidth,
            height: 42,
            bgcolor: "background.paper",
            borderBottom: "1px solid",
            borderColor: "divider",
            fontWeight: 700,
          }}
        >
          {selection ? (
            <Box
              role="columnheader"
              sx={{
                position: "sticky",
                left: 0,
                zIndex: 9,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: "background.paper",
                borderRight: "1px solid",
                borderColor: "divider",
              }}
            >
              <Checkbox
                size="small"
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                inputProps={{ "aria-label": "选择当前页全部条目" }}
                onChange={(_, checked) =>
                  selection.onChange(
                    checked
                      ? new Set(selectableRows.map((row) => rowKey(row)))
                      : new Set(),
                  )
                }
              />
            </Box>
          ) : null}
          {visible.map((column) => (
            <Box
              key={column.id}
              role="columnheader"
              sx={{
                px: 1.25,
                display: "flex",
                alignItems: "center",
                borderRight: "1px solid",
                borderColor: "divider",
                minWidth: 0,
                ...pinnedStyle(column, true),
              }}
            >
              <Typography
                variant="caption"
                fontWeight={700}
                noWrap
                sx={{ flex: 1 }}
              >
                {column.label}
              </Typography>
              <IconButton
                size="small"
                aria-label={`管理${typeof column.label === "string" ? column.label : "此"}列`}
                onClick={(event) =>
                  setMenu({ anchor: event.currentTarget, columnId: column.id })
                }
                sx={{ p: 0.25, ml: 0.25 }}
              >
                <MoreVertIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
        {rows.length ? (
          <Box
            sx={{
              position: "relative",
              width: contentWidth,
              height: rows.length * rowHeight,
            }}
          >
            {rows.slice(start, end).map((row, localIndex) => {
              const index = start + localIndex;
              return (
                <Box
                  key={rowKey(row)}
                  role="row"
                  onClick={() => onRowClick?.(row)}
                  sx={{
                    position: "absolute",
                    top: index * rowHeight,
                    left: 0,
                    display: "grid",
                    gridTemplateColumns: template,
                    width: contentWidth,
                    height: rowHeight,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    cursor: onRowClick ? "pointer" : "default",
                    "&:hover": {
                      bgcolor: "action.hover",
                      "& > div:first-of-type": { bgcolor: "action.hover" },
                    },
                  }}
                >
                  {selection ? (
                    <Box
                      sx={{
                        position: "sticky",
                        left: 0,
                        zIndex: 4,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: "background.paper",
                        borderRight: "1px solid",
                        borderColor: "divider",
                      }}
                    >
                      <Checkbox
                        size="small"
                        disabled={selection.isRowSelectable?.(row) === false}
                        checked={selection.selectedKeys.has(rowKey(row))}
                        inputProps={{ "aria-label": "选择此条目" }}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(_, checked) => {
                          const next = new Set(selection.selectedKeys);
                          if (checked) next.add(rowKey(row));
                          else next.delete(rowKey(row));
                          selection.onChange(next);
                        }}
                      />
                    </Box>
                  ) : null}
                  {visible.map((column) => cell(column, row))}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box sx={{ p: 4, minWidth: contentWidth, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              {empty}
            </Typography>
          </Box>
        )}
      </Box>
      {bulkActionBar ? (
        <Paper
          elevation={6}
          sx={{
            position: "absolute",
            left: 8,
            bottom: 8,
            zIndex: 12,
            display: "inline-flex",
            alignItems: "center",
            width: "max-content",
            maxWidth: "calc(100% - 16px)",
            overflowX: "auto",
            px: 1.5,
            py: 0.75,
          }}
        >
          {bulkActionBar}
        </Paper>
      ) : null}

      <Dialog
        open={!!expanded}
        onClose={() => setExpanded(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{expanded?.title}</DialogTitle>
        <DialogContent>
          <Box
            component="pre"
            sx={{
              m: 0,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              font: "inherit",
            }}
          >
            {expanded?.text}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExpanded(null)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
