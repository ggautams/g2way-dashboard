/**
 * Errors a gateway call can end in. Universal — safe to import from client
 * components — so nothing here may know about environments or the admin secret.
 */

/**
 * The gateway (or the BFF, which uses the same envelope) answered with a non-2xx
 * status. `message` is the envelope's `error` string verbatim: the dashboard
 * surfaces what the gateway said and never substitutes a friendlier message.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The environment that answered, when known. */
    readonly environment?: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /**
   * Builds the error from a parsed response body. g2way's envelope is
   * `{"error": "..."}`; any other body falls back to `HTTP <status>`.
   */
  static fromBody(status: number, body: unknown, environment?: string): GatewayError {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string' &&
      body.error !== ''
        ? body.error
        : `HTTP ${status}`;
    return new GatewayError(status, message, environment);
  }
}

/** The gateway could not be reached at all: no status, only a network failure. */
export class GatewayUnreachableError extends Error {
  constructor(
    readonly environment: string,
    cause: unknown,
  ) {
    super(`gateway unreachable (environment ${environment}): ${describeFetchError(cause)}`, {
      cause,
    });
    this.name = 'GatewayUnreachableError';
  }
}

/** Why a fetch failed. Node reports every network error as "fetch failed", with the real reason as its `cause`. */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
