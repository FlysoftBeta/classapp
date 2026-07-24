import { userSchema, type User } from "@/shared/types/api";
import { resourceManager } from "./ResourceManager";

const SESSION_KEY = "offline:v1:session";
let pendingWrite = Promise.resolve();

function enqueueWrite(run: () => Promise<void>): Promise<void> {
  const operation = pendingWrite.catch(() => {}).then(run);
  pendingWrite = operation.catch(() => {});
  return operation;
}

export interface OfflineSession {
  token: string;
  user: User;
}

export const offlineSession = {
  async get(): Promise<OfflineSession | null> {
    const value = await resourceManager.getJson<unknown>(SESSION_KEY);
    if (!value || typeof value !== "object") return null;
    const candidate = value as { token?: unknown; user?: unknown };
    const user = userSchema.safeParse(candidate.user);
    if (typeof candidate.token !== "string" || !candidate.token || !user.success)
      return null;
    return { token: candidate.token, user: user.data };
  },

  async save(session: OfflineSession): Promise<void> {
    await enqueueWrite(() =>
      resourceManager.putJson(SESSION_KEY, session, "persisted"),
    );
  },

  async clear(): Promise<void> {
    await enqueueWrite(async () => {
      await resourceManager.remove(SESSION_KEY);
    });
  },
};
