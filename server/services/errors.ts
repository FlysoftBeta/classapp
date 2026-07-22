export class ServiceError extends Error {
  status: number;
  extra?: Record<string, unknown>;

  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.extra = extra;
  }
}

export function handleServiceError(e: unknown): Response {
  if (e instanceof ServiceError) {
    return Response.json(
      { error: e.message, ...e.extra },
      { status: e.status },
    );
  }
  throw e;
}
