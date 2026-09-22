import 'server-only';

import { can, type Permission } from '@/lib/auth/rbac';
import {
  applyKeyOp,
  describeBulkOp,
  parseBulkRequest,
  type BulkAnswer,
  type BulkItemResult,
  type BulkRequest,
} from '@/lib/bulk/ops';
import type { AuditActor, AuditRecord } from '@/lib/db/audit';
import type { JsonValue } from '@/lib/db/schema/shared';
import type { KeySession } from '@/lib/keys/session';
import { databaseAuditSink } from './audit-trail';
import { RegistryConfigError, UnknownEnvironmentError, getRegistry } from './environments';
import { GatewayError } from './errors';
import { mapLimit } from './keys';
import {
  ENVIRONMENT_HEADER,
  errorResponse,
  isCrossSite,
  originConfig,
  proxyToGateway,
  recordLoudly,
  requestTarget,
  type ProxyDeps,
} from './proxy';

/**
 * Bulk operations (`POST /api/g2/bulk`). g2way has no batch endpoint, so each
 * item is its own gateway call made through {@link proxyToGateway}: permission
 * checked, org-scoped and audited on its own (`key.update`, `key.delete`,
 * `policy.delete`) exactly like the same change made one at a time, including
 * the key-metadata cleanup after a key delete. Nothing here writes to the
 * gateway any other way.
 *
 * Around the items sits one summary row (`key.bulk` / `policy.bulk`), written
 * `pending` before any call (fail closed) and completed with the tally. Items
 * run {@link BULK_CONCURRENCY} at a time and never stop each other: the answer
 * is 200 with one result per item, the gateway's own message on each failure.
 */

export const BULK_ACTIONS = { keys: 'key.bulk', policies: 'policy.bulk' } as const;
const BULK_CONCURRENCY = 5;

const PERMISSION: Record<BulkRequest['collection'], Permission> = {
  keys: 'keys:write',
  policies: 'policies:write',
};

async function json(response: Response): Promise<JsonValue | null> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

async function failure(id: string, response: Response): Promise<BulkItemResult> {
  const { message } = GatewayError.fromBody(response.status, await json(response));
  return { id, outcome: 'failed', error: message, status: response.status };
}

/**
 * Runs the bulk request in `request`'s body for `actor`. Answers 200 with a
 * {@link BulkAnswer}, or the `{"error"}` envelope: 400 for a malformed request
 * or unknown environment, 403 for a refusal (audited), 503 when the summary
 * row cannot be written (nothing is sent).
 */
export async function runBulkOperation(
  request: Request,
  actor: AuditActor,
  deps: ProxyDeps = {},
): Promise<Response> {
  const audit = deps.audit ?? databaseAuditSink();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'invalid bulk request: the body is not JSON');
  }
  const parsed = parseBulkRequest(body);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const bulk = parsed.value;
  const policy = bulk.collection === 'keys' ? bulk.policy : undefined;
  const summary = describeBulkOp({ ...bulk, policy });
  const base: AuditRecord = {
    actor,
    action: BULK_ACTIONS[bulk.collection],
    target: null,
    request: { op: bulk.op, ids: bulk.ids, ...(policy === undefined ? {} : { policy }) },
    outcome: 'pending',
  };

  const deny = async (message: string) => {
    await recordLoudly(audit, { ...base, outcome: 'denied', error: message });
    return errorResponse(403, message);
  };
  const permission = PERMISSION[bulk.collection];
  if (!can(actor.role, permission)) {
    return deny(
      `forbidden: the ${actor.role} role lacks the ${permission} permission (bulk ${summary})`,
    );
  }
  // The only CSRF check: the per-item calls below carry no Origin or Sec-Fetch-Site.
  if (isCrossSite(request, deps.origin ?? originConfig())) {
    return deny('cross-site request refused');
  }

  let environment: string;
  try {
    environment = requestTarget(request, deps.registry ?? getRegistry()).id;
  } catch (error) {
    if (error instanceof UnknownEnvironmentError) return errorResponse(400, error.message);
    if (error instanceof RegistryConfigError) return errorResponse(500, error.message);
    throw error;
  }
  const envHeader = { [ENVIRONMENT_HEADER]: environment };

  const notes = [
    `bulk ${summary} of ${bulk.ids.length} ${bulk.collection}: one gateway call per item, each audited on its own`,
  ];
  const record: AuditRecord = { ...base, environment, notes };
  let auditId: string;
  try {
    auditId = await audit.record(record);
  } catch (error) {
    console.error(`[audit] FAILED to record ${record.action} by ${actor.email}; refused:`, error);
    return errorResponse(
      503,
      'audit log unavailable: nothing was sent to the gateway (see the dashboard server log)',
      envHeader,
    );
  }

  /** One gateway call through the audited proxy, pinned to the environment resolved above. */
  const call = (method: string, path: string, payload?: JsonValue) =>
    proxyToGateway(
      new Request(new URL(`/api${path}`, request.url), {
        method,
        headers: { ...envHeader, accept: 'application/json', 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
      path.split('?')[0].split('/').slice(2).map(decodeURIComponent),
      actor,
      { ...deps, audit },
    );

  const one = async (id: string): Promise<BulkItemResult> => {
    const item = `/g2/${bulk.collection}/${encodeURIComponent(id)}`;
    const query = bulk.collection === 'keys' ? '?hashed=true' : '';
    if (bulk.op === 'delete') {
      const removed = await call('DELETE', `${item}${query}`);
      return removed.ok ? { id, outcome: 'done', status: removed.status } : failure(id, removed);
    }
    // Key updates: the session as stored now, changed in one field, written back.
    const read = await call('GET', `${item}${query}`);
    if (!read.ok) return failure(id, read);
    const session = await json(read);
    if (typeof session !== 'object' || session === null || Array.isArray(session)) {
      return {
        id,
        outcome: 'failed',
        error: 'GET /g2/keys/{key} answered without a session object',
      };
    }
    const change = applyKeyOp(session as KeySession, bulk.op, policy);
    if ('unchanged' in change) return { id, outcome: 'unchanged', reason: change.unchanged };
    const written = await call('PUT', `${item}${query}`, change.next as JsonValue);
    return written.ok ? { id, outcome: 'done', status: written.status } : failure(id, written);
  };

  const results = await mapLimit(bulk.ids, BULK_CONCURRENCY, one);

  const failed = results.filter((r) => r.outcome === 'failed');
  const done = results.filter((r) => r.outcome === 'done').length;
  const unchanged = results.length - done - failed.length;
  const final: AuditRecord = {
    ...record,
    after: results as unknown as JsonValue,
    outcome: failed.length === 0 ? 'success' : 'failure',
    error:
      failed.length === 0
        ? undefined
        : `${failed.length} of ${results.length} failed: ${failed
            .slice(0, 5)
            .map((r) => `${r.id}: ${r.outcome === 'failed' ? r.error : ''}`)
            .join('; ')}${failed.length > 5 ? '; …' : ''}`,
    notes: [...notes, `${done} done, ${unchanged} unchanged, ${failed.length} failed`],
  };
  try {
    await audit.complete(auditId, final);
  } catch (error) {
    console.error(
      `[audit] FAILED to complete audit row ${auditId} (${final.outcome} ${final.action}); it stays pending:`,
      error,
    );
  }

  const answer: BulkAnswer = { collection: bulk.collection, op: bulk.op, results };
  return Response.json(answer, {
    status: 200,
    headers: { 'cache-control': 'no-store', ...envHeader },
  });
}
