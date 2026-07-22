import { create } from "zustand";

export type AppTaskKind =
  | "article-upload"
  | "network-download"
  | "article-offline"
  | "conversation-offline";
export type AppTaskStatus = "queued" | "running" | "completed" | "failed";

export interface AppTask {
  id: string;
  kind: AppTaskKind;
  title: string;
  status: AppTaskStatus;
  progress: number;
  total: number;
  etaMs?: number;
  detail?: string;
  articleId?: string | null;
  updatedAt: number;
}

interface TaskState {
  tasks: AppTask[];
  upsert: (task: AppTask) => void;
  patch: (id: string, patch: Partial<AppTask>) => void;
  clearFinished: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  upsert: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((item) => item.id === task.id);
      if (index < 0) return { tasks: [task, ...state.tasks].slice(0, 100) };

      // Polling changes progress and updatedAt frequently. Keep an existing task
      // in its original slot so the list does not jump while someone reads it.
      const tasks = [...state.tasks];
      tasks[index] = task;
      return { tasks };
    }),
  patch: (id, patch) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id ? { ...task, ...patch, updatedAt: Date.now() } : task,
      ),
    })),
  clearFinished: () =>
    set((state) => ({
      tasks: state.tasks.filter(
        (task) => task.status === "queued" || task.status === "running",
      ),
    })),
}));

export const taskStore = useTaskStore;

export function newTaskId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}:${Date.now().toString(36)}:${suffix}`;
}
