import 'server-only';

import { can } from '@/lib/auth/rbac';
import { getDatabase } from '@/lib/db';
import { queryTail, type AnalyticsTailRow } from '@/lib/db/analytics';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import type { User } from '@/lib/db/users';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { shortHash } from '@/lib/keys/session';
import { describeValue, parseDrill, type Drill } from './drill';
import {
  LIVE_LIMIT,
  TAIL_MAX_AGE_MS,
  tailFilter,
  type LiveRequest,
  type LiveSnapshot,
} from './tail';

/**
 * The live request inspector's reads (ADR-0014): the environment's tail, as
 * the browser may see it. Used by `/analytics/live` for the first render and
 * by `GET /api/analytics/live` for every poll after it, so both answer alike.
 * Reads the dashboard database only: no gateway call, no Redis.
 */

/** The newest requests matching the selection, shaped for the role. */
export async function loadLiveRequests(
  target: GatewayTarget,
  drill: Pick<Drill, 'apiId' | 'focus'>,
  role: User['role'],
  now: number = Date.now(),
): Promise<LiveSnapshot> {
  const db = getDatabase();
  const orgId = getOrgId();
  const rows = await queryTail(db, orgId, {
    environment: target.id,
    since: new Date(now - TAIL_MAX_AGE_MS),
    filter: tailFilter(drill),
    limit: LIVE_LIMIT,
  });
  const keys = can(role, 'keys:read');
  const hashes = keys ? [...new Set(rows.flatMap((row) => row.keyHash ?? []))] : [];
  const labels =
    hashes.length === 0
      ? new Map<string, { label: string | null }>()
      : await listKeyMetadata(db, orgId, target.id, hashes);
  return {
    requests: rows.map((row) => toLiveRequest(row, keys ? labels : null)),
    now,
  };
}

/**
 * One tail row for the browser. Without `keys:read` (`labels` null) the key is
 * left out entirely, as the drill-down leaves out its key tab.
 */
export function toLiveRequest(
  row: AnalyticsTailRow,
  labels: ReadonlyMap<string, { label: string | null }> | null,
): LiveRequest {
  const request: LiveRequest = {
    id: row.id,
    at: row.at.getTime(),
    apiId: row.apiId,
    method: row.method,
    path: row.path,
    pathTemplate: row.pathTemplate,
    status: row.status,
    latencyMs: row.latencyMs,
    upstreamLatencyMs: row.upstreamLatencyMs,
    requestBytes: row.requestBytes,
    responseBytes: row.responseBytes,
  };
  if (labels !== null) {
    const hash = row.keyHash;
    request.key = {
      hash,
      ...describeValue('key', hash ?? '', {
        keyLabel: hash === null ? null : (labels.get(hash)?.label ?? null),
        alias: row.keyAlias,
        shortHash,
      }),
    };
  }
  return request;
}

const NO_STORE = { 'cache-control': 'no-store' };

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * `GET /api/analytics/live?api=&status=&…`: one poll. Takes the drill-down's
 * parameters (`parseDrill`), in the environment the user has selected. Needs
 * `analytics:inspect` (403 otherwise), answers in the `{"error"}` envelope on
 * failure, and is never cached.
 */
export async function liveRequestsResponse(request: Request, user: User): Promise<Response> {
  if (!can(user.role, 'analytics:inspect')) {
    return refuse(
      403,
      `forbidden: the ${user.role} role lacks the analytics:inspect permission (live requests)`,
    );
  }
  let target: GatewayTarget;
  try {
    target = resolveEnvironment(await selectedEnvironmentId());
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return refuse(409, error.message);
    }
    throw error;
  }
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const drill = parseDrill(params, { keys: can(user.role, 'keys:read') });
  const snapshot = await loadLiveRequests(target, drill, user.role);
  return Response.json({ ...snapshot, notes: drill.notes }, { headers: NO_STORE });
}
