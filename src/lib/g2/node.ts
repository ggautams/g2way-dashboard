/**
 * Response bodies of `GET /g2/node`, `/g2/version` and `/g2/health`.
 *
 * **Hand-typed, on purpose and temporarily.** g2way declares these three responses
 * with no content schema (`content?: never` in `contracts/g2way.d.ts`); `/g2/node`
 * is an untyped `serde_json::json!` in `crates/g2-admin/src/dashboard.rs`. Until
 * upstream gives them `ToSchema` types (open item in `UPSTREAM.md`), the shapes
 * live here — and because nothing checks them at compile time, every body is
 * parsed at runtime, so an upstream change fails loudly with the field that moved
 * instead of rendering garbage. `crates/g2-admin/src` is in the `admin-api` watch
 * area, so the drift check fires when that file changes.
 *
 * Universal: no secret, nothing `server-only`.
 */

/** Circuit-breaker state names, from `breaker_state()` in `crates/g2-proxy/src/forward.rs`. */
export const BREAKER_STATES = ['closed', 'open', 'half_open'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

/** Last poll of a background sync (service discovery or GraphQL schema sync). */
export type SyncStatus = {
  /** Unix seconds of the last successful poll; null until the first one. */
  last_success_unix_secs: number | null;
  /** The last poll's error; null when the last poll succeeded. */
  last_error: string | null;
};

export type DiscoveryStatus = SyncStatus & { endpoint: string | null };

/**
 * One API in the node's live route table. For a *versioned* API the target
 * fields describe the unused base target — each version rotates, probes, polls
 * and breaks its own targets, which `/g2/node` does not surface — so the four
 * nullable status fields read null there.
 */
export type NodeRoute = {
  api_id: string;
  name: string;
  org_id: string;
  listen_path: string;
  target_url: string;
  target_list: string[];
  /** Addresses actually in rotation: the configured targets until discovery swaps them. */
  live_targets: string[];
  /** Per-address health, in `live_targets` order; null when health checking is off. */
  target_health: boolean[] | null;
  /** Null when service discovery is off. */
  service_discovery: DiscoveryStatus | null;
  /** Null when GraphQL schema sync is off. */
  graphql_schema_sync: SyncStatus | null;
  /** Null when circuit breaking is off. */
  circuit_breaker: BreakerState | null;
  auth_mode: string;
};

export type NodeInfo = {
  /** `$HOSTNAME` — the pod name under k8s; null for a bare process. */
  node_id: string | null;
  version: string;
  uptime_secs: number;
  routes: number;
  apis: NodeRoute[];
};

export type VersionInfo = { version: string };
export type HealthInfo = { status: string };

/** A gateway body did not have the shape this dashboard expects: the contract moved. */
export class PayloadShapeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly path: string,
    expected: string,
    actual: unknown,
  ) {
    super(`${endpoint}: expected ${path} to be ${expected}, got ${describe(actual)}`);
    this.name = 'PayloadShapeError';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'string' ? `"${value}"` : typeof value;
}

type Obj = Record<string, unknown>;

/** Field readers bound to one endpoint, so every error names where it came from. */
function readers(endpoint: string) {
  const fail = (path: string, expected: string, actual: unknown): never => {
    throw new PayloadShapeError(endpoint, path, expected, actual);
  };
  const object = (value: unknown, path: string): Obj =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Obj)
      : fail(path, 'an object', value);
  const string = (value: unknown, path: string): string =>
    typeof value === 'string' ? value : fail(path, 'a string', value);
  const count = (value: unknown, path: string): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : fail(path, 'a non-negative integer', value);
  const nullable =
    <T>(read: (value: unknown, path: string) => T) =>
    (value: unknown, path: string): T | null =>
      value === null || value === undefined ? null : read(value, path);
  const array =
    <T>(read: (value: unknown, path: string) => T) =>
    (value: unknown, path: string): T[] =>
      Array.isArray(value)
        ? value.map((item, i) => read(item, `${path}[${i}]`))
        : fail(path, 'an array', value);
  const boolean = (value: unknown, path: string): boolean =>
    typeof value === 'boolean' ? value : fail(path, 'a boolean', value);
  return { fail, object, string, count, nullable, array, boolean };
}

export function parseNodeInfo(body: unknown): NodeInfo {
  const r = readers('GET /g2/node');

  const sync = (value: unknown, path: string): SyncStatus => {
    const o = r.object(value, path);
    return {
      last_success_unix_secs: r.nullable(r.count)(
        o.last_success_unix_secs,
        `${path}.last_success_unix_secs`,
      ),
      last_error: r.nullable(r.string)(o.last_error, `${path}.last_error`),
    };
  };

  const breaker = (value: unknown, path: string): BreakerState =>
    (BREAKER_STATES as readonly unknown[]).includes(value)
      ? (value as BreakerState)
      : r.fail(path, `one of ${BREAKER_STATES.join('/')}`, value);

  const route = (value: unknown, path: string): NodeRoute => {
    const o = r.object(value, path);
    const at = (field: string) => `${path}.${field}`;
    return {
      api_id: r.string(o.api_id, at('api_id')),
      name: r.string(o.name, at('name')),
      org_id: r.string(o.org_id, at('org_id')),
      listen_path: r.string(o.listen_path, at('listen_path')),
      target_url: r.string(o.target_url, at('target_url')),
      target_list: r.array(r.string)(o.target_list ?? [], at('target_list')),
      live_targets: r.array(r.string)(o.live_targets, at('live_targets')),
      target_health: r.nullable(r.array(r.boolean))(o.target_health, at('target_health')),
      service_discovery: r.nullable((v, p) => ({
        ...sync(v, p),
        endpoint: r.nullable(r.string)(r.object(v, p).endpoint, `${p}.endpoint`),
      }))(o.service_discovery, at('service_discovery')),
      graphql_schema_sync: r.nullable(sync)(o.graphql_schema_sync, at('graphql_schema_sync')),
      circuit_breaker: r.nullable(breaker)(o.circuit_breaker, at('circuit_breaker')),
      auth_mode: r.string(o.auth_mode, at('auth_mode')),
    };
  };

  const o = r.object(body, 'body');
  return {
    node_id: r.nullable(r.string)(o.node_id, 'node_id'),
    version: r.string(o.version, 'version'),
    uptime_secs: r.count(o.uptime_secs, 'uptime_secs'),
    routes: r.count(o.routes, 'routes'),
    apis: r.array(route)(o.apis, 'apis'),
  };
}

export function parseVersionInfo(body: unknown): VersionInfo {
  const r = readers('GET /g2/version');
  return { version: r.string(r.object(body, 'body').version, 'version') };
}

export function parseHealthInfo(body: unknown): HealthInfo {
  const r = readers('GET /g2/health');
  return { status: r.string(r.object(body, 'body').status, 'status') };
}

/**
 * Per-target health, paired with its address. `null` health means the gateway
 * is not probing (health checks off) — distinct from `false`, which is a
 * probed, failing target.
 */
export function targetsWithHealth(
  route: Pick<NodeRoute, 'live_targets' | 'target_health'>,
): { address: string; healthy: boolean | null }[] {
  return route.live_targets.map((address, i) => ({
    address,
    healthy: route.target_health?.[i] ?? null,
  }));
}
