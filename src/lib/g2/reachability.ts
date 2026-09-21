import 'server-only';
import { unwrap } from './client';
import {
  RegistryConfigError,
  getRegistry,
  listEnvironments,
  type PublicEnvironment,
  type Registry,
} from './environments';
import { GatewayError, GatewayUnreachableError } from './errors';
import { gatewayClient, type GatewayClientDeps } from './server-client';

/**
 * Whether each configured gateway can be managed right now — what the shell's
 * degraded-mode banner shows on every page. One authenticated call per
 * environment: `/g2/health` is unauthenticated, so it would pass with a wrong
 * admin secret; `/g2/version` fails both ways and is cheap.
 */

/** A dead gateway must not stall every page for the client's full timeout. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Renders within this window share one probe per environment. */
export const PROBE_TTL_MS = 5_000;

export type Probe = { environment: PublicEnvironment } & (
  | { state: 'ok' }
  | { state: 'unreachable'; message: string }
  /** 401/403: the gateway answered but refused the admin secret. */
  | { state: 'refused'; status: number; message: string }
  | { state: 'error'; status: number; message: string }
);

export type Reachability =
  | { kind: 'probed'; probes: Probe[] }
  /** The dashboard's own config is unusable; `problems` names each variable. */
  | { kind: 'misconfigured'; problems: readonly string[] };

type CacheEntry = { at: number; probe: Promise<Probe> };

export type ProbeDeps = Omit<GatewayClientDeps, 'registry'> & {
  registry?: Registry;
  now?: () => number;
  cache?: Map<string, CacheEntry>;
};

const processCache = new Map<string, CacheEntry>();

async function probeOne(environment: PublicEnvironment, deps: ProbeDeps): Promise<Probe> {
  const client = gatewayClient(environment.id, { timeoutMs: PROBE_TIMEOUT_MS, ...deps });
  try {
    await unwrap(client.GET('/g2/version'));
    return { environment, state: 'ok' };
  } catch (error) {
    if (error instanceof GatewayUnreachableError) {
      return { environment, state: 'unreachable', message: error.message };
    }
    if (error instanceof GatewayError) {
      const state = error.status === 401 || error.status === 403 ? 'refused' : 'error';
      return { environment, state, status: error.status, message: error.message };
    }
    throw error;
  }
}

/** Probes every configured environment in parallel, reusing probes younger than {@link PROBE_TTL_MS}. */
export async function probeEnvironments(deps: ProbeDeps = {}): Promise<Reachability> {
  let registry: Registry;
  try {
    registry = deps.registry ?? getRegistry();
  } catch (error) {
    if (error instanceof RegistryConfigError) {
      return { kind: 'misconfigured', problems: error.problems };
    }
    throw error;
  }

  const now = (deps.now ?? Date.now)();
  const cache = deps.cache ?? processCache;
  const probes = listEnvironments(registry).map((environment) => {
    const hit = cache.get(environment.id);
    if (hit && now - hit.at < PROBE_TTL_MS) return hit.probe;
    const probe = probeOne(environment, { ...deps, registry });
    cache.set(environment.id, { at: now, probe });
    // A rejected probe is a dashboard bug; don't keep serving it from the cache.
    probe.catch(() => cache.delete(environment.id));
    return probe;
  });
  return { kind: 'probed', probes: await Promise.all(probes) };
}
