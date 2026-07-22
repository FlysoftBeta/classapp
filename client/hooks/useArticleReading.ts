import { useEffect } from "react";
import { reportArticleReading } from "@/client/api/articles";
import { READING_HEARTBEAT_SECONDS } from "@/shared/types/api/article";

export function useArticleReading(articleId: string, online = true) {
  useEffect(() => {
    if (!online) return;
    reportArticleReading(articleId, {
      seconds: 0,
      active: true,
    }).catch(() => {});

    const id = window.setInterval(() => {
      reportArticleReading(articleId, {
        seconds: READING_HEARTBEAT_SECONDS,
        active: true,
      }).catch(() => {});
    }, READING_HEARTBEAT_SECONDS * 1000);

    return () => {
      window.clearInterval(id);
      reportArticleReading(articleId, {
        seconds: 0,
        active: false,
      }).catch(() => {});
    };
  }, [articleId, online]);
}
