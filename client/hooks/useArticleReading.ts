import { useEffect } from "react";
import { reportArticleReading } from "@/client/interact/articles";
import { READING_HEARTBEAT_SECONDS } from "@/shared/types/api/article";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

export function useArticleReading(articleId: string, online = true) {
  useEffect(() => {
    if (!online) return;
    reportArticleReading(articleId, {
      seconds: 0,
      active: true,
    }).catch((error) => {
      captureDetachedClientIncident("article.reading-start", error);
    });

    const id = window.setInterval(() => {
      reportArticleReading(articleId, {
        seconds: READING_HEARTBEAT_SECONDS,
        active: true,
      }).catch((error) => {
        captureDetachedClientIncident("article.reading-heartbeat", error);
      });
    }, READING_HEARTBEAT_SECONDS * 1000);

    return () => {
      window.clearInterval(id);
      reportArticleReading(articleId, {
        seconds: 0,
        active: false,
      }).catch((error) => {
        captureDetachedClientIncident("article.reading-stop", error);
      });
    };
  }, [articleId, online]);
}
