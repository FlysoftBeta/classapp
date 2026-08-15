import { useMemo, useState, type ReactNode, type UIEvent } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Menu from "@mui/material/Menu";
import Typography from "@mui/material/Typography";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";

export interface AdminGridColumn<Row> {
  id: string;
  label: ReactNode;
  width: number;
  render: (row: Row) => ReactNode;
  hiddenByDefault?: boolean;
  longText?: (row: Row) => string | null | undefined;
}

export function AdminDataGrid<Row>({
  rows,
  columns,
  rowKey,
  onRowClick,
  height = 520,
  empty = "暂无数据",
}: {
  rows: readonly Row[];
  columns: readonly AdminGridColumn<Row>[];
  rowKey: (row: Row) => string | number;
  onRowClick?: (row: Row) => void;
  height?: number;
  empty?: ReactNode;
}) {
  const [hidden, setHidden] = useState(
    () =>
      new Set(
        columns
          .filter((column) => column.hiddenByDefault)
          .map((column) => column.id),
      ),
  );
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [expanded, setExpanded] = useState<{
    title: ReactNode;
    text: string;
  } | null>(null);
  const visible = useMemo(
    () => columns.filter((column) => !hidden.has(column.id)),
    [columns, hidden],
  );
  const rowHeight = 52;
  const overscan = 6;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(height / rowHeight) + overscan * 2;
  const end = Math.min(rows.length, start + count);
  const template = visible.map((column) => `${column.width}px`).join(" ");
  const contentWidth = visible.reduce(
    (total, column) => total + column.width,
    0,
  );

  const cell = (column: AdminGridColumn<Row>, row: Row, index: number) => {
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
          ...(index === 0 && {
            position: "sticky",
            left: 0,
            zIndex: 2,
            bgcolor: "background.paper",
            boxShadow: "2px 0 3px rgba(0,0,0,0.05)",
          }),
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
    <Box>
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
        <Button
          size="small"
          startIcon={<ViewColumnIcon />}
          onClick={(event) => setMenuAnchor(event.currentTarget)}
        >
          选择列
        </Button>
      </Box>
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={() => setMenuAnchor(null)}
      >
        {columns.map((column, index) => (
          <FormControlLabel
            key={column.id}
            sx={{ display: "flex", px: 1.25, mx: 0 }}
            control={
              <Checkbox
                size="small"
                checked={!hidden.has(column.id)}
                disabled={index === 0}
                onChange={(_, checked) =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (checked) next.delete(column.id);
                    else next.add(column.id);
                    return next;
                  })
                }
              />
            }
            label={column.label}
          />
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
          {visible.map((column, index) => (
            <Box
              key={column.id}
              role="columnheader"
              sx={{
                px: 1.25,
                display: "flex",
                alignItems: "center",
                borderRight: "1px solid",
                borderColor: "divider",
                ...(index === 0 && {
                  position: "sticky",
                  left: 0,
                  zIndex: 6,
                  bgcolor: "background.paper",
                  boxShadow: "2px 0 3px rgba(0,0,0,0.05)",
                }),
              }}
            >
              <Typography variant="caption" fontWeight={700}>
                {column.label}
              </Typography>
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
                  {visible.map((column, columnIndex) =>
                    cell(column, row, columnIndex),
                  )}
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
