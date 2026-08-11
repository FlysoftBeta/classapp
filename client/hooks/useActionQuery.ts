import { useState, useEffect, useCallback, type DependencyList } from "react";
import { captureClientOperation } from "@/client/interact/clientIncidents";
type LoadActionData<T> = () => Promise<T>;

export function useActionQuery<T>(
  loadData: LoadActionData<T>,
  deps: DependencyList = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await captureClientOperation("ui.action-query", () => loadData()),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [loadData]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial query bootstraps component state
    void load();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, loading, error, reload: load };
}
