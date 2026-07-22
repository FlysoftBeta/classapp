export class TomatoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TomatoError";
  }
}

export class VerificationRequiredError extends TomatoError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationRequiredError";
  }
}

export class ClientBusyError extends TomatoError {
  constructor(
    readonly retryAfterMs: number,
    readonly readyAt: number,
  ) {
    super(`Client 正在冷却，预计 ${Math.ceil(retryAfterMs / 1000)} 秒后可用`);
    this.name = "ClientBusyError";
  }
}
