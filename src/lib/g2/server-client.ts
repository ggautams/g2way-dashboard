import 'server-only';
import { createG2Client, type G2Client } from './client';
import { resolveEnvironment, type Registry } from './environments';
import { GatewayUnreachableError } from './errors';
import { withOrgId } from './org-scope';

/**
 * The typed gateway client for server code (Server Components, route handlers,
 * workers): calls one environment's admin API directly with its secret, rather
 * than looping back through the BFF over HTTP.
 */

/** The gateway's admin auth header. */
export const ADMIN_SECRET_HEADER = 'X-G2-Authorization';

/** How long a single admin call may take before it counts as unreachable. */
export const GATEWAY_TIMEOUT_MS = 10_000;

export type GatewayClientDeps = {
  fetch?: typeof fetch;
  registry?: Registry;
};

/**
 * A client for environment `environmentId` (the default one when omitted). Throws
 * `UnknownEnvironmentError` / `RegistryConfigError` from the registry; calls throw
 * {@link GatewayUnreachableError} on a network failure or timeout.
 */
export function gatewayClient(environmentId?: string, deps: GatewayClientDeps = {}): G2Client {
  const target = resolveEnvironment(environmentId, deps.registry);
  const baseFetch = deps.fetch ?? fetch;

  const client = createG2Client({
    baseUrl: target.baseUrl,
    headers: { [ADMIN_SECRET_HEADER]: target.secret },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        return await baseFetch(input, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GatewayUnreachableError(target.id, error);
      }
    },
  });

  client.use({
    onRequest({ request, schemaPath }) {
      const url = new URL(request.url);
      const scoped = withOrgId(url, request.method, schemaPath, target.orgId);
      return scoped === url ? undefined : new Request(scoped, request);
    },
  });

  return client;
}
