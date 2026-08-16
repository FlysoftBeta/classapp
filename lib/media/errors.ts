/** Provider-facing error taxonomy. Server layers map these to PublicError. */
export type MediaErrorKind =
  | "not-found"
  | "rate-limited"
  | "provider-unavailable"
  | "pot-unavailable"
  | "timeout"
  | "output-too-large"
  | "invalid-payload"
  | "cancelled"
  | "backend-missing";

export class MediaError extends Error {
  constructor(
    readonly kind: MediaErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MediaError";
  }
}
