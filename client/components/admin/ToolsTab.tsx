import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import DownloadIcon from "@mui/icons-material/Download";
import GridOnIcon from "@mui/icons-material/GridOn";
import RefreshIcon from "@mui/icons-material/Refresh";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import TextSnippetIcon from "@mui/icons-material/TextSnippet";
import {
  adminCleanupTeachDocuments,
  adminFetchTeachDocuments,
  adminRunTool,
  adminTeachDocumentDownloadUrl,
  type AdminTeachDocument,
} from "@/client/api/admin";
import { formatBytes } from "@/shared/bytes";
import { formatDeviceDateTime } from "@/client/lib/deviceTime";

const DOCUMENT_REFRESH_MS = 4_000;

function DocumentTypeIcon({
  type,
}: {
  type: AdminTeachDocument["document_type"];
}) {
  if (type === "word") return <TextSnippetIcon fontSize="small" />;
  if (type === "powerpoint") return <SlideshowIcon fontSize="small" />;
  return <GridOnIcon fontSize="small" />;
}

export function ToolsTab({ token }: { token: string }) {
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [documents, setDocuments] = useState<AdminTeachDocument[]>([]);
  const [monitorAvailable, setMonitorAvailable] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);

  const loadDocuments = useCallback(async (showLoading = false) => {
    if (showLoading) setDocumentsLoading(true);
    try {
      const data = await adminFetchTeachDocuments();
      setDocuments(data.documents);
      setMonitorAvailable(data.monitor_available);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "文档列表加载失败");
    } finally {
      if (showLoading) setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial admin tool data
    void loadDocuments(true);
    const timer = window.setInterval(
      () => void loadDocuments(),
      DOCUMENT_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [loadDocuments]);

  const run = async (action: "kill-wps" | "shutdown", label: string) => {
    if (action === "shutdown" && !confirm("确认立即关闭计算机？")) return;
    setBusy(action);
    setMsg("");
    setErr("");
    const { res, data } = await adminRunTool(action);
    setBusy(null);
    if (res.ok) {
      setMsg(data.message || `${label}命令已发送`);
    } else {
      setErr(data.error || `${label}失败`);
    }
  };

  const cleanupDocuments = async () => {
    if (
      documents.length > 0 &&
      !confirm(`确认清理全部 ${documents.length} 个暂存文档？`)
    ) {
      return;
    }
    setBusy("cleanup-documents");
    setMsg("");
    setErr("");
    const result = await adminCleanupTeachDocuments();
    setBusy(null);
    if (result.res.ok) {
      const deleted = "deleted" in result.data ? result.data.deleted : 0;
      await loadDocuments();
      setMsg(`已清理 ${deleted} 个文档`);
    } else {
      setErr("error" in result.data ? result.data.error : "文档清理失败");
    }
  };

  return (
    <Box>
      <Typography variant="body2" color="red" sx={{ mb: 2 }}>
        谨慎使用！
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <Button
          variant="outlined"
          disabled={busy !== null}
          onClick={() => run("kill-wps", "关闭 WPS")}
        >
          {busy === "kill-wps" ? "执行中…" : "关闭 WPS"}
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={busy !== null}
          onClick={() => run("shutdown", "关机")}
        >
          {busy === "shutdown" ? "执行中…" : "关机"}
        </Button>
      </Stack>

      {msg && (
        <Alert severity="success" onClose={() => setMsg("")} sx={{ mt: 2 }}>
          {msg}
        </Alert>
      )}
      {err && (
        <Alert severity="error" onClose={() => setErr("")} sx={{ mt: 2 }}>
          {err}
        </Alert>
      )}

      <Box
        sx={{
          mt: 3,
          pt: 2.5,
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={2}
          sx={{ mb: 0.5 }}
        >
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              教学文档暂存
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="刷新">
              <span>
                <IconButton
                  size="small"
                  disabled={documentsLoading}
                  onClick={() => void loadDocuments(true)}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Button
              size="small"
              color="error"
              startIcon={<DeleteSweepIcon />}
              disabled={busy !== null || documentsLoading}
              onClick={() => void cleanupDocuments()}
            >
              {busy === "cleanup-documents" ? "清理中…" : "清理全部"}
            </Button>
          </Stack>
        </Stack>

        {!monitorAvailable && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Office 文档监听仅在 Windows 服务器上运行。
          </Alert>
        )}

        {documentsLoading ? (
          <Box sx={{ py: 5, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : documents.length === 0 ? (
          <Box
            sx={{
              mt: 2,
              py: 5,
              px: 2,
              textAlign: "center",
              color: "text.secondary",
              border: "1px dashed",
              borderColor: "divider",
              borderRadius: 2,
            }}
          >
            <Typography variant="body2">还没有捕获到已打开的文档</Typography>
          </Box>
        ) : (
          <Box sx={{ mt: 2, ml: 1 }}>
            {documents.map((document, index) => (
              <Box
                key={document.id}
                sx={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "28px minmax(0, 1fr) auto",
                  columnGap: 1.5,
                  pb: index === documents.length - 1 ? 0 : 2.5,
                  "&::before":
                    index === documents.length - 1
                      ? undefined
                      : {
                          content: '""',
                          position: "absolute",
                          top: 24,
                          bottom: 0,
                          left: 13,
                          width: "2px",
                          bgcolor: "divider",
                        },
                }}
              >
                <Box
                  sx={{
                    zIndex: 1,
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    color: "primary.contrastText",
                    bgcolor:
                      document.document_type === "word"
                        ? "#2b579a"
                        : document.document_type === "powerpoint"
                          ? "#d24726"
                          : "#217346",
                  }}
                >
                  <DocumentTypeIcon type={document.document_type} />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    title={document.name}
                    sx={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {document.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatDeviceDateTime(document.created_at, true)} ·{" "}
                    {document.application} · {formatBytes(document.file_size)}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() =>
                    window.open(
                      adminTeachDocumentDownloadUrl(token, document.id),
                      "_blank",
                    )
                  }
                >
                  下载
                </Button>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
