import 'server-only';
import { unwrap } from './client';
import { resolveEnvironment } from './environments';
import { GatewayError, GatewayUnreachableError } from './errors';
import {
  PayloadShapeError,
  parseHealthInfo,
  parseNodeInfo,
  parseVersionInfo,
  type HealthInfo,
  type NodeInfo,
  type VersionInfo,
} from './node';
import { gatewayClient, type GatewayClientDeps } from './server-client';

/**
 * Everything the Gateway page shows about one environment, fetched in parallel.
 * Each endpoint settles on its own, so one failing call degrades its panel
 * rather than the page: `/g2/health` is unauthenticated, so "health passes but
 * node is 403" is how a wrong admin secret shows up.
 */

export type Outcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** The gateway's `{"error"}` message verbatim, or why it could not be reached or parsed. */
      error: string;
      /** The gateway's HTTP status, when it answered at all. */
      status?: number;
    };

export type GatewayStatus = {
  environment: string;
  health: Outcome<HealthInfo>;
  version: Outcome<VersionInfo>;
  node: Outcome<NodeInfo>;
  /** Unix milliseconds when the calls were made — ages on the page are relative to it. */
  fetchedAt: number;
};

/** Runs `work`, settling the failures a page shows (gateway, network, payload shape). */
export async function settle<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    // These three carry a complete message; anything else is a dashboard bug
    // and should surface as one, not as a gateway problem.
    if (error instanceof GatewayError) {
      return { ok: false, error: error.message, status: error.status };
    }
    if (error instanceof GatewayUnreachableError || error instanceof PayloadShapeError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Loads the status of environment `environmentId` (the default one when omitted).
 * Registry errors (`RegistryConfigError`, `UnknownEnvironmentError`) are thrown,
 * not settled: they are about this dashboard's config, not the gateway.
 */
export async function loadGatewayStatus(
  environmentId?: string,
  deps: GatewayClientDeps & { now?: () => number } = {},
): Promise<GatewayStatus> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  const fetchedAt = (deps.now ?? Date.now)();
  const [health, version, node] = await Promise.all([
    settle(async () => parseHealthInfo(await unwrap(client.GET('/g2/health')))),
    settle(async () => parseVersionInfo(await unwrap(client.GET('/g2/version')))),
    settle(async () => parseNodeInfo(await unwrap(client.GET('/g2/node')))),
  ]);
  return {
    environment: id,
    health,
    version,
    node,
    fetchedAt,
  };
}
