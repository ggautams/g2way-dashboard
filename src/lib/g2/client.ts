import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../../../contracts/g2way.d.ts';
import { GatewayError } from './errors';

/**
 * The typed gateway client. Every path, parameter, body and response type comes
 * from `contracts/g2way.d.ts`, generated from g2way's OpenAPI document — nothing
 * here is hand-written.
 *
 * Universal: this module holds no secret and must never import `environments` or
 * anything else `server-only`. Client components use {@link bffClient}, which goes
 * through the BFF proxy; server code uses `gatewayClient()` from `./server-client`.
 */

export type G2Client = Client<paths>;

/** Request header naming the environment the BFF should call; the default one when absent. */
export const ENVIRONMENT_HEADER = 'x-g2-environment';

export type G2ClientOptions = {
  /** Prefix for the spec's `/g2/...` paths: a gateway admin URL, or `/api` for the BFF. */
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

export function createG2Client({ baseUrl, headers, fetch }: G2ClientOptions): G2Client {
  return createClient<paths>({ baseUrl, headers, fetch, cache: 'no-store' });
}

/**
 * A client for the browser: calls `/api/g2/...`, where the BFF attaches the admin
 * secret server-side. `baseUrl` only needs overriding outside a browser (tests).
 */
export function bffClient(
  environmentId?: string,
  options: Partial<G2ClientOptions> = {},
): G2Client {
  return createG2Client({
    baseUrl: '/api',
    ...options,
    headers: {
      ...options.headers,
      ...(environmentId === undefined ? {} : { [ENVIRONMENT_HEADER]: environmentId }),
    },
  });
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/**
 * Resolves a client call to its typed success body, or throws {@link GatewayError}
 * carrying the gateway's own `{"error"}` message and status.
 *
 * ```ts
 * const apis = await unwrap(client.GET('/g2/apis'));
 * ```
 */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    throw GatewayError.fromBody(
      response.status,
      error,
      response.headers.get(ENVIRONMENT_HEADER) ?? undefined,
    );
  }
  return data as T;
}
