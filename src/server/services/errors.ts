/** Domain error raised by services; the admin API maps `status` and `code` to the HTTP response. */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 502,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
