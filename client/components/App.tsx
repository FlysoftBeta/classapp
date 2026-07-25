import React, { useState, useMemo, useCallback, useEffect } from "react";
import { createTheme, ThemeProvider, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import CssBaseline from "@mui/material/CssBaseline";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import LockScreen from "./auth/LockScreen";
import LoginScreen from "./auth/LoginScreen";
import OnboardingFlow from "./auth/OnboardingFlow";
import AppLockedScreen from "./auth/AppLockedScreen";
import ConversationList from "./sidebar/Sidebar";
import ChatView from "./chat/ChatView";
import Settings from "./settings/Settings";
import AdminPanel from "./admin/AdminPanel";
import ArticleList from "./articles/ArticleList";
import ArticleReader from "./articles/ArticleReader";
import Learning from "./learning/Learning";
import WordLearningPage from "./learning/WordLearningPage";
import WrongWordsPage from "./learning/WrongWordsPage";
import MasteredWordsPage from "./learning/MasteredWordsPage";
import ClearWrongWordsPage from "./learning/ClearWrongWordsPage";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import WifiOffIcon from "@mui/icons-material/WifiOff";
import DebugMenu from "./debug/DebugMenu";

import { useAppLogic, type ConvEntry } from "../hooks/useAppLogic";
import { useMessageBanner } from "../hooks/useMessageBanner";
import MessageBanner from "./notifications/MessageBanner";
import { readUserSetting, writeUserSetting } from "../api/versionedSettings";
import { fetchNotificationConfig } from "../api/notificationConfig";
import {
  acknowledgeAnnouncement,
  fetchAnnouncement,
} from "../api/announcement";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { announcementEvents } from "@/client/app/events";
import { offlineRepository } from "../resource/offlineRepository";
import type { AppRoute, ViewType } from "../app/appReducer";
import { vh, inset } from "@/client/lib/css";
import { hasFeature } from "@/shared/features";

function buildTheme(mode: "light" | "dark") {
  return createTheme({
    palette: {
      mode,
      primary: { main: "#1d9bf0" },
    },
    typography: {
      fontFamily:
        '"Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
    },
    components: {
      MuiButton: {
        styleOverrides: { root: { textTransform: "none", borderRadius: 20 } },
      },
      MuiTab: {
        styleOverrides: { root: { textTransform: "none", minWidth: 0 } },
      },
      MuiDialog: {
        defaultProps: {
          disableScrollLock: true,
          slotProps: {
            backdrop: {
              sx: {
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              },
            },
          },
        },
      },
    },
  });
}

// ── App shell (desktop + mobile layout) ──────────────────────────────────────
function AppShell({
  logic,
  themeMode,
  setThemeMode,
}: {
  logic: ReturnType<typeof useAppLogic>;
  themeMode: "light" | "dark";
  setThemeMode: React.Dispatch<React.SetStateAction<"light" | "dark">>;
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [learningProgress, setLearningProgress] = useState({
    total: 0,
    correct: 0,
  });
  const [pendingRoute, setPendingRoute] = useState<AppRoute | null>(null);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [doNotDisturb, setDoNotDisturb] = useState(false);
  const [announcement, setAnnouncement] = useState<{
    content: string;
    revision: number;
  } | null>(null);

  const {
    user,
    token,
    route,
    navigate,
    selected,
    conversations,
    handleConversationUpdate,
    handleLeftGroup,
    subscribePostEvents,
    handleNewDm,
    handleLogout,
    setUser,
    articleSidebar,
    articleListRevision,
    subscribeConfigEvents,
    online,
  } = logic;

  const view = route.view;
  const adminEnabled = hasFeature(user, "admin");
  const offlineEnabled = hasFeature(user, "offline");
  const articlesEnabled = hasFeature(user, "articles");
  const learningEnabled = hasFeature(user, "learning");
  const articleDownloadEnabled = hasFeature(user, "article_download");

  const handleNavigate = useCallback(
    (newRoute: AppRoute, extra?: () => void) => {
      const learningViews: ViewType[] = ["word-learning", "clear-wrong"];
      if (learningViews.includes(view) && learningProgress.total > 0) {
        setPendingRoute(newRoute);
        setShowExitConfirm(true);
        return;
      }
      navigate(newRoute);
      extra?.();
    },
    [view, learningProgress.total, navigate],
  );

  const confirmExitLearning = useCallback(() => {
    if (pendingRoute) {
      navigate(pendingRoute);
      setPendingRoute(null);
    }
    setShowExitConfirm(false);
    setLearningProgress({ total: 0, correct: 0 });
  }, [pendingRoute, navigate]);

  const cancelExitLearning = useCallback(() => {
    setPendingRoute(null);
    setShowExitConfirm(false);
  }, []);

  const handleSelectConv = useCallback(
    (conv: ConvEntry) => {
      navigate({
        view: "chat",
        conversation: { type: conv.type, id: conv.id },
      });
      if (isMobile) setMobileShowContent(true);
    },
    [navigate, isMobile],
  );

  const handleMobileBack = useCallback(() => {
    setMobileShowContent(false);
    navigate({ view: "chat", conversation: null });
  }, [navigate]);

  const handleOpenArticle = useCallback(
    (articleId: string) => {
      if (!articlesEnabled) return;
      const from =
        route.view === "articles"
          ? "articles"
          : route.view === "reader"
            ? route.from
            : "chat";
      navigate({ view: "reader", articleId, from });
      if (isMobile) setMobileShowContent(true);
    },
    [navigate, isMobile, route, articlesEnabled],
  );

  const handleArticlesBack = useCallback(() => {
    const destination = route.view === "reader" ? route.from : "articles";
    if (isMobile) {
      navigate(
        destination === "articles"
          ? { view: "articles" }
          : { view: "chat", conversation: null },
      );
      setMobileShowContent(destination === "articles");
    } else {
      navigate({ view: "articles" });
    }
  }, [navigate, isMobile, route]);

  const showList = !isMobile || !mobileShowContent;
  const showContent = !isMobile || mobileShowContent;

  useEffect(() => {
    let cancelled = false;
    fetchNotificationConfig().then((config) => {
      if (!cancelled) setDoNotDisturb(config.doNotDisturb);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void fetchAnnouncement().then((value) => {
      if (!cancelled && value && !value.acknowledged && value.content) {
        setAnnouncement({ content: value.content, revision: value.revision });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleAcknowledgeAnnouncement = useCallback(async () => {
    if (announcement === null) return;
    const result = await acknowledgeAnnouncement(announcement.revision);
    if (result.ok && result.data.acknowledged) {
      setAnnouncement(null);
    } else if (result.ok) {
      const latest = await fetchAnnouncement();
      if (latest && !latest.acknowledged && latest.content)
        setAnnouncement({ content: latest.content, revision: latest.revision });
    }
  }, [announcement]);

  useEffect(() => {
    return announcementEvents.subscribe(() => {
      void fetchAnnouncement().then((value) => {
        if (value && !value.acknowledged && value.content) {
          setAnnouncement({ content: value.content, revision: value.revision });
        } else {
          setAnnouncement(null);
        }
      });
    });
  }, []);

  useEffect(() => {
    return subscribeConfigEvents((evt) => {
      if (evt.key === USER_CONFIG.DO_NOT_DISTURB) {
        setDoNotDisturb(evt.value === "true");
      }
    });
  }, [subscribeConfigEvents]);

  const { banner, dismiss: dismissBanner } = useMessageBanner({
    subscribePostEvents,
    currentUserId: user!.id,
    conversations,
    route,
    isMobile,
    mobileShowContent,
    doNotDisturb,
  });

  const handleOpenConversationFromBanner = useCallback(
    (convType: "group" | "dm", convId: string) => {
      const conv = conversations.find(
        (c) => c.type === convType && c.id === convId,
      );
      if (conv) {
        handleSelectConv(conv);
      } else {
        navigate({ view: "chat", conversation: null });
        if (isMobile) setMobileShowContent(true);
        handleConversationUpdate();
      }
    },
    [
      conversations,
      handleSelectConv,
      navigate,
      isMobile,
      handleConversationUpdate,
    ],
  );

  if (!online && !offlineEnabled) {
    return <Box sx={{ minHeight: vh(1), bgcolor: "#fff" }} />;
  }

  return (
    <Box
      sx={{
        minHeight: vh(1),
        display: "flex",
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{
          display: showList ? "flex" : "none",
          flexDirection: "column",
          width: isMobile ? "100%" : sidebarCollapsed ? 0 : 260,
          minWidth: 0,
          flexShrink: 0,
          height: vh(1),
          position: isMobile ? "relative" : "sticky",
          top: 0,
          transition: "width 0.3s ease",
          overflow: "hidden",
          visibility: isMobile || !sidebarCollapsed ? "visible" : "hidden",
        }}
      >
        <ConversationList
          currentUser={user!}
          conversations={conversations}
          selected={selected}
          onSelect={handleSelectConv}
          onConversationsChanged={handleConversationUpdate}
          onSettings={() => {
            navigate({ view: "settings" });
            if (isMobile) setMobileShowContent(true);
          }}
          onAdmin={() => {
            navigate({ view: "admin" });
            if (isMobile) setMobileShowContent(true);
          }}
          onArticles={() => {
            navigate({ view: "articles" });
            if (isMobile) setMobileShowContent(true);
          }}
          onLearning={() => {
            handleNavigate({ view: "learning" }, () => {
              if (isMobile) setMobileShowContent(true);
            });
          }}
          onOpenArticle={handleOpenArticle}
          sidebarArticles={articleSidebar.articles}
          currentArticleId={
            route.view === "reader"
              ? route.articleId
              : articleSidebar.current_article_id
          }
          themeMode={themeMode}
          online={online}
          adminEnabled={adminEnabled}
          articlesEnabled={articlesEnabled}
          learningEnabled={learningEnabled}
        />
      </Box>

      <Box
        sx={{
          display: showContent ? "flex" : "none",
          flex: 1,
          minWidth: 0,
          flexDirection: "column",
          minHeight: vh(1),
        }}
      >
        {!isMobile && (
          <IconButton
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            size="small"
            sx={{
              position: "fixed",
              left: sidebarCollapsed ? 8 : 260,
              top: "50%",
              transform: sidebarCollapsed
                ? "translateY(-50%)"
                : "translate(-50%, -50%)",
              zIndex: 1000,
              width: 32,
              height: 32,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 2,
              boxShadow: 1,
              "&:hover": {
                bgcolor: "action.hover",
              },
              transition: "left 0.3s ease, transform 0.3s ease",
            }}
          >
            {sidebarCollapsed ? (
              <ChevronRightIcon fontSize="small" />
            ) : (
              <ChevronLeftIcon fontSize="small" />
            )}
          </IconButton>
        )}

        {view === "chat" && (
          <ChatView
            currentUser={user!}
            token={token}
            conversation={selected}
            onStartDm={handleNewDm}
            onConversationUpdate={handleConversationUpdate}
            onLeftGroup={handleLeftGroup}
            subscribePostEvents={subscribePostEvents}
            subscribeConfigEvents={subscribeConfigEvents}
            onBack={isMobile ? handleMobileBack : undefined}
            onOpenArticle={handleOpenArticle}
            online={online}
            offlineEnabled={offlineEnabled}
            articlesEnabled={articlesEnabled}
          />
        )}
        {view === "settings" && (
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <Settings
              currentUser={user!}
              themeMode={themeMode}
              onThemeToggle={() =>
                setThemeMode((m) => (m === "light" ? "dark" : "light"))
              }
              onUserUpdated={setUser}
              onLogout={handleLogout}
              onBack={isMobile ? handleMobileBack : undefined}
              doNotDisturb={doNotDisturb}
              onDoNotDisturbChange={setDoNotDisturb}
              online={online}
            />
          </Box>
        )}
        {view === "admin" && online && adminEnabled && (
          <Box
            sx={{ flex: 1, minHeight: 0, height: vh(1), overflow: "hidden" }}
          >
            <AdminPanel
              token={token}
              currentUser={user!}
              onBack={isMobile ? handleMobileBack : undefined}
            />
          </Box>
        )}
        {view === "articles" && articlesEnabled && (
          <ArticleList
            sidebarArticles={articleSidebar.articles}
            currentArticleId={articleSidebar.current_article_id}
            onOpenArticle={handleOpenArticle}
            refreshKey={articleListRevision}
            onBack={isMobile ? handleMobileBack : undefined}
            token={token}
            downloadEnabled={articleDownloadEnabled}
          />
        )}
        {route.view === "reader" && articlesEnabled && (
          <ArticleReader
            articleId={route.articleId}
            token={token}
            currentUserId={user!.id}
            isAdmin={adminEnabled}
            onBack={handleArticlesBack}
            onDeleted={() => {
              navigate({ view: "articles" });
            }}
            themeMode={themeMode}
            subscribeConfigEvents={subscribeConfigEvents}
            online={online}
            offlineEnabled={offlineEnabled}
          />
        )}
        {view === "learning" && online && learningEnabled && (
          <Learning
            onBack={
              isMobile
                ? handleMobileBack
                : () => navigate({ view: "chat", conversation: null })
            }
            onNavigate={(newView) => {
              navigate({ view: newView });
              if (isMobile) setMobileShowContent(true);
            }}
          />
        )}
        {view === "word-learning" && online && learningEnabled && (
          <WordLearningPage
            onBack={() => handleNavigate({ view: "learning" })}
            onProgress={setLearningProgress}
          />
        )}
        {view === "wrong-words" && online && learningEnabled && (
          <WrongWordsPage
            onBack={() => navigate({ view: "learning" })}
            onNavigate={(newView) => navigate({ view: newView })}
          />
        )}
        {view === "clear-wrong" && online && learningEnabled && (
          <ClearWrongWordsPage
            onBack={() => handleNavigate({ view: "wrong-words" })}
            onProgress={setLearningProgress}
          />
        )}
        {view === "mastered-words" && online && learningEnabled && (
          <MasteredWordsPage onBack={() => navigate({ view: "learning" })} />
        )}
        {!online &&
          [
            "settings",
            "admin",
            "learning",
            "word-learning",
            "wrong-words",
            "clear-wrong",
            "mastered-words",
          ].includes(view) && (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "text.disabled",
              }}
            >
              <Typography variant="body2">
                此功能未缓存，恢复连接后可用
              </Typography>
            </Box>
          )}
      </Box>

      <Dialog open={showExitConfirm} onClose={cancelExitLearning}>
        <DialogTitle>退出学习</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 4 }}>
            {learningProgress.total === 0
              ? "本次学习你还没有开始学习单词哦~"
              : `你个肺雾😡才学了${learningProgress.total}个单词，居然连全对都做不到，仅仅只有${Math.round((learningProgress.correct / learningProgress.total) * 100)}%的正确率，你不配和神使用同一个暗网`}
          </Typography>
          <Box sx={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
            <Button onClick={cancelExitLearning}>继续学习</Button>
            <Button variant="contained" onClick={confirmExitLearning}>
              确认退出
            </Button>
          </Box>
        </DialogContent>
      </Dialog>

      <Dialog open={!!announcement} disableEscapeKeyDown>
        <DialogTitle>公告</DialogTitle>
        <DialogContent>
          <Typography sx={{ whiteSpace: "pre-wrap", mb: 3 }}>
            {announcement?.content}
          </Typography>
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="contained"
              onClick={() => void handleAcknowledgeAnnouncement()}
            >
              我已阅读并确认
            </Button>
          </Box>
        </DialogContent>
      </Dialog>

      <MessageBanner
        banner={banner}
        onDismiss={dismissBanner}
        onOpenConversation={handleOpenConversationFromBanner}
      />
      {!online && (
        <Box
          role="status"
          sx={{
            position: "fixed",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            px: 1.5,
            py: 0.5,
            borderRadius: 4,
            bgcolor: "warning.main",
            color: "warning.contrastText",
            boxShadow: 3,
          }}
        >
          <WifiOffIcon sx={{ fontSize: 16 }} />
          <Typography variant="caption" fontWeight={700}>
            离线
          </Typography>
        </Box>
      )}
    </Box>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const setVH = () => {
      const vh = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    };
    setVH();
    (viewport ?? window).addEventListener("resize", setVH);
    return () => (viewport ?? window).removeEventListener("resize", setVH);
  }, []);

  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const theme = useMemo(() => buildTheme(themeMode), [themeMode]);
  const logic = useAppLogic();

  const {
    appState,
    appDisable,
    user,
    clientId,
    oobe,
    setOobe,
    oobeHandle,
    setOobeHandle,
    oobeUsername,
    setOobeUsername,
    loginLoading,
    loginError,
    handleLoginPin,
    handleOobePin,
    handleOobeSubmit,
    handleLogout,
    unlockKonami,
    lockKonami,
    subscribeConfigEvents,
  } = logic;

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    void readUserSetting(USER_CONFIG.THEME_MODE, "light").then((value) => {
      if (active) setThemeMode(value === "dark" ? "dark" : "light");
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(
    () =>
      subscribeConfigEvents((event) => {
        if (event.updatedAt !== undefined && event.value !== null) {
          void offlineRepository
            .reconcileVersionedValue("user-config", event.key, {
              value: event.value,
              updatedAt: event.updatedAt,
            })
            .then((winner) => {
              if (event.key === USER_CONFIG.THEME_MODE) {
                setThemeMode(winner.value === "dark" ? "dark" : "light");
              }
            });
        }
      }),
    [subscribeConfigEvents],
  );

  const setPersistentThemeMode: React.Dispatch<
    React.SetStateAction<"light" | "dark">
  > = useCallback((next) => {
    setThemeMode((current) => {
      const value = typeof next === "function" ? next(current) : next;
      void writeUserSetting(USER_CONFIG.THEME_MODE, value);
      return value;
    });
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />

      {appState === "loading" && (
        <Box style={{ position: "fixed", background: "#fff", ...inset(0) }} />
      )}

      {appState === "konami" && <LockScreen onUnlock={unlockKonami} />}

      {appState === "login" && (
        <LoginScreen
          onComplete={handleLoginPin}
          loading={loginLoading}
          error={loginError}
          clientId={clientId}
        />
      )}

      {appState === "oobe" && oobe && (
        <OnboardingFlow
          oobe={oobe}
          oobeHandle={oobeHandle}
          setOobeHandle={setOobeHandle}
          oobeUsername={oobeUsername}
          setOobeUsername={setOobeUsername}
          onPin={handleOobePin}
          onSubmit={handleOobeSubmit}
          onStepChange={(step) => {
            if (oobe) setOobe({ ...oobe, step });
          }}
          clientId={clientId}
        />
      )}

      {appState === "app_locked" && (
        <AppLockedScreen
          state={appDisable}
          onAutoLock={lockKonami}
          onLogout={handleLogout}
          onLockNow={lockKonami}
        />
      )}

      {appState === "app" && user && (
        <AppShell
          logic={logic}
          themeMode={themeMode}
          setThemeMode={setPersistentThemeMode}
        />
      )}

      <DebugMenu />
    </ThemeProvider>
  );
}
