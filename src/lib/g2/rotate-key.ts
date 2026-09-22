import 'server-only';

import { can } from '@/lib/auth/rbac';
import type { AuditActor, AuditRecord, GatewayCall } from '@/lib/db/audit';
import type { JsonValue } from '@/lib/db/schema/shared';
import type { RotateAnswer } from '@/lib/keys/save';
import { parseCreatedKey } from '@/lib/keys/session';
import { databaseAuditSink } from './audit-trail';
import { RegistryConfigError, UnknownEnvironmentError, getRegistry } from './environments';
import { GatewayError } from './errors';
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
 * Key rotation (ADR-0009). g2way has no rotate endpoint, so the BFF composes
 * one from three calls, each made through {@link proxyToGateway} so it is
 * permission-checked, org-scoped and audited on its own like any browser call:
 *
 *   1. `GET /g2/keys/{old}?hashed=true` — the session to carry over;
 *   2. `POST /g2/keys` with that session — the new key (raw key, shown once);
 *   3. `DELETE /g2/keys/{old}?hashed=true` — retire the old one.
 *
 * Around them sits one `key.rotate` audit row linking the old and new hashes,
 * written `pending` before any call (fail closed, as for every write) and
 * completed with the outcome. The raw key goes back to the caller in the
 * response and nowhere else: not into any audit row, not into a log.
 *
 * Not atomic. A failed read or create leaves the old key untouched; a failed
 * delete after a successful create leaves **both keys working**, which the
 * answer (`outcome: "partial"`) and the audit row say, naming the new hash.
 */

export const ROTATE_ACTION = 'key.rotate';

async function json(response: Response): Promise<JsonValue | null> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

function answer(status: number, body: RotateAnswer, environment: string): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', [ENVIRONMENT_HEADER]: environment },
  });
}

/**
 * Rotates the key stored under `oldHash` for `actor` (who needs `keys:write`).
 * Answers 201 with a {@link RotateAnswer}, or the `{"error"}` envelope: the
 * gateway's own message and status when one of its calls failed, 403 for a
 * refusal, 503 when the audit row cannot be written (nothing is sent).
 */
export async function rotateKey(
  request: Request,
  oldHash: string,
  actor: AuditActor,
  deps: ProxyDeps = {},
): Promise<Response> {
  const audit = deps.audit ?? databaseAuditSink();
  const hashPath = `/g2/keys/${encodeURIComponent(oldHash)}`;
  const base: AuditRecord = {
    actor,
    action: ROTATE_ACTION,
    target: oldHash,
    request: { rotate: oldHash },
    outcome: 'pending',
  };

  const deny = async (message: string) => {
    await recordLoudly(audit, { ...base, outcome: 'denied', error: message });
    return errorResponse(403, message);
  };
  if (oldHash === '' || /[/?#]/.test(oldHash)) {
    return errorResponse(400, `not a key hash: ${oldHash}`);
  }
  if (!can(actor.role, 'keys:write')) {
    return deny(`forbidden: the ${actor.role} role lacks the keys:write permission (key rotate)`);
  }
  // The only CSRF check: the three calls below carry no Origin or Sec-Fetch-Site.
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
    'rotation is three gateway calls, each also audited on its own (key.create, key.delete)',
  ];
  const record: AuditRecord = { ...base, environment, notes };
  let auditId: string;
  try {
    auditId = await audit.record(record);
  } catch (error) {
    console.error(`[audit] FAILED to record ${ROTATE_ACTION} by ${actor.email}; refused:`, error);
    return errorResponse(
      503,
      'audit log unavailable: the rotation was not started (see the dashboard server log)',
      envHeader,
    );
  }
  const complete = async (final: AuditRecord) => {
    try {
      await audit.complete(auditId, final);
    } catch (error) {
      console.error(
        `[audit] FAILED to complete audit row ${auditId} (${final.outcome} ${ROTATE_ACTION}); it stays pending:`,
        error,
      );
    }
  };

  /** One gateway call through the audited proxy, pinned to the environment resolved above. */
  const call = (method: string, path: string, body?: string) =>
    proxyToGateway(
      new Request(new URL(`/api${path}`, request.url), {
        method,
        headers: { ...envHeader, accept: 'application/json', 'content-type': 'application/json' },
        body,
      }),
      path.split('?')[0].split('/').slice(2).map(decodeURIComponent),
      actor,
      { ...deps, audit },
    );
  const gatewayCall = (method: string, path: string, status: number): GatewayCall => ({
    method,
    path,
    status,
  });

  /** A step failed before anything changed: record it and pass the gateway's answer on. */
  const stopped = async (step: string, response: Response, gateway: GatewayCall) => {
    const { message } = GatewayError.fromBody(response.status, await json(response));
    await complete({
      ...record,
      gateway,
      outcome: 'failure',
      error: `${step}: ${message}`,
      notes: [...notes, 'the old key is unchanged'],
    });
    return errorResponse(response.status, message, envHeader);
  };

  // 1. The session to carry over.
  const read = await call('GET', `${hashPath}?hashed=true`);
  if (!read.ok) {
    return stopped('reading the key failed', read, gatewayCall('GET', hashPath, read.status));
  }
  const session = await json(read);
  if (typeof session !== 'object' || session === null || Array.isArray(session)) {
    return stopped(
      'reading the key failed',
      Response.json(
        { error: 'GET /g2/keys/{key} answered without a session object' },
        { status: 502 },
      ),
      gatewayCall('GET', hashPath, read.status),
    );
  }
  const before: JsonValue = { key_hash: oldHash, session };

  // 2. The new key, with the same session.
  const created = await call('POST', '/g2/keys', JSON.stringify(session));
  const createCall = gatewayCall('POST', '/g2/keys', created.status);
  if (!created.ok) {
    return stopped('creating the new key failed', created, createCall);
  }
  let newKey: { key: string; key_hash: string };
  try {
    newKey = parseCreatedKey(await json(created));
  } catch (error) {
    const message = `the gateway answered ${created.status} but ${error instanceof Error ? error.message : String(error)}; a new key may exist that nobody holds, and the old key is unchanged`;
    await complete({ ...record, before, gateway: createCall, outcome: 'failure', error: message });
    return errorResponse(502, message, envHeader);
  }
  const after: JsonValue = { key_hash: newKey.key_hash, session };
  notes.push(`new key ${newKey.key_hash}`);

  // The dashboard's label, owner and notes follow the key (ADR-0009 §7). Copied,
  // not moved: step 3's delete drops the old row, so a completed rotation moves
  // it and a partial one leaves both keys described.
  if (audit.carryKey !== undefined) {
    try {
      const carried = await audit.carryKey({
        environment,
        from: oldHash,
        to: newKey.key_hash,
        actor,
      });
      if (carried) notes.push('key metadata (label, owner, notes) carried to the new key');
    } catch (error) {
      console.error(
        `[audit] FAILED to carry key metadata from ${oldHash} to ${newKey.key_hash} (key.metadata.rekey):`,
        error,
      );
      notes.push('key metadata could not be carried to the new key (see the server log)');
    }
  }

  // 3. Retire the old key.
  const removed = await call('DELETE', `${hashPath}?hashed=true`);
  const deleteCall = gatewayCall('DELETE', hashPath, removed.status);
  if (!removed.ok) {
    const { message } = GatewayError.fromBody(removed.status, await json(removed));
    await complete({
      ...record,
      before,
      after,
      gateway: deleteCall,
      outcome: 'failure',
      error: `both keys now exist: created ${newKey.key_hash}, but deleting ${oldHash} failed: ${message}`,
      notes,
    });
    return answer(
      201,
      {
        outcome: 'partial',
        key: newKey.key,
        key_hash: newKey.key_hash,
        old_hash: oldHash,
        error: message,
      },
      environment,
    );
  }

  await complete({ ...record, before, after, gateway: deleteCall, outcome: 'success', notes });
  return answer(
    201,
    { outcome: 'rotated', key: newKey.key, key_hash: newKey.key_hash, old_hash: oldHash },
    environment,
  );
}
