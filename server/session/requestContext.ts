import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  token: string | null;
  userId: string | null;
  clientId: string | null;
  ip: string;
  userAgent: string;
  mac: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(
  context: RequestContext,
  handler: () => Promise<T>,
): Promise<T> {
  return storage.run(context, handler);
}

export function requestContext(): RequestContext {
  return (
    storage.getStore() ?? {
      token: null,
      userId: null,
      clientId: null,
      ip: "127.0.0.1",
      userAgent: "",
      mac: null,
    }
  );
}
