import { formatAge } from '@/lib/format';
import {
  targetsWithHealth,
  type BreakerState,
  type DiscoveryStatus,
  type NodeRoute,
  type SyncStatus,
} from '@/lib/g2/node';

/**
 * The node's live route table: one row per routed API with its targets, their
 * health, the circuit breaker and the background syncs. Every status column
 * reads "off" when the feature is not enabled — and also for a versioned API,
 * whose versions each keep their own state that `/g2/node` does not surface.
 */

const OFF_TITLE = 'Not enabled — or the API is versioned, and each version keeps its own state';

function Off() {
  return (
    <span className="text-muted" title={OFF_TITLE}>
      off
    </span>
  );
}

function Pill({ tone, children }: { tone: 'success' | 'warning' | 'danger'; children: string }) {
  const tones = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
  } as const;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Targets({ route }: { route: NodeRoute }) {
  const targets = targetsWithHealth(route);
  if (targets.length === 0) return <span className="text-muted">none</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {targets.map(({ address, healthy }, i) => (
        <li key={`${address}-${i}`} className="flex items-center gap-1.5 font-mono text-xs">
          <span
            role="img"
            aria-label={healthy === null ? 'not probed' : healthy ? 'healthy' : 'unhealthy'}
            title={healthy === null ? 'Health checks off' : healthy ? 'Healthy' : 'Unhealthy'}
            className={`size-2 shrink-0 rounded-full ${
              healthy === null ? 'border border-muted' : healthy ? 'bg-success' : 'bg-danger'
            }`}
          />
          <span className="break-all">{address}</span>
        </li>
      ))}
    </ul>
  );
}

const BREAKER_TONE: Record<BreakerState, 'success' | 'warning' | 'danger'> = {
  closed: 'success',
  half_open: 'warning',
  open: 'danger',
};

function Breaker({ state }: { state: BreakerState | null }) {
  if (state === null) return <Off />;
  return <Pill tone={BREAKER_TONE[state]}>{state.replace('_', '-')}</Pill>;
}

function Sync({ status, now }: { status: SyncStatus | DiscoveryStatus | null; now: number }) {
  if (status === null) return <Off />;
  const endpoint = 'endpoint' in status ? status.endpoint : null;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {status.last_error !== null ? (
        <Pill tone="danger">error</Pill>
      ) : status.last_success_unix_secs === null ? (
        <Pill tone="warning">pending</Pill>
      ) : (
        <Pill tone="success">ok</Pill>
      )}
      {status.last_success_unix_secs !== null && (
        <span className="text-muted">last ok {formatAge(status.last_success_unix_secs, now)}</span>
      )}
      {status.last_error !== null && (
        // The gateway's own message, verbatim.
        <span className="break-words font-mono text-danger">{status.last_error}</span>
      )}
      {endpoint !== null && (
        <span className="break-all font-mono text-muted" title="Discovery endpoint">
          {endpoint}
        </span>
      )}
    </div>
  );
}

export function RouteTable({ routes, now }: { routes: readonly NodeRoute[]; now: number }) {
  if (routes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
        This node is routing no APIs. Definitions saved to the gateway go live after{' '}
        <code>POST /g2/reload</code>.
      </p>
    );
  }
  const sorted = [...routes].sort((a, b) => a.listen_path.localeCompare(b.listen_path));
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="border-b border-border text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              API
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Listen path
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Auth
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Live targets
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Circuit
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Discovery
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              GraphQL sync
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border align-top">
          {sorted.map((route) => (
            <tr key={route.api_id}>
              <td className="px-3 py-2">
                <div className="font-medium">{route.name}</div>
                <div className="font-mono text-xs text-muted">{route.api_id}</div>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{route.listen_path}</td>
              <td className="px-3 py-2 font-mono text-xs">{route.auth_mode}</td>
              <td className="px-3 py-2">
                <Targets route={route} />
              </td>
              <td className="px-3 py-2">
                <Breaker state={route.circuit_breaker} />
              </td>
              <td className="px-3 py-2">
                <Sync status={route.service_discovery} now={now} />
              </td>
              <td className="px-3 py-2">
                <Sync status={route.graphql_schema_sync} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
