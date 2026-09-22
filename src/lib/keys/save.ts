/**
 * Writing keys from the browser, through the BFF (`bffClient`) like every
 * gateway write: it holds the secret, checks the role (`keys:write`) and origin,
 * scopes the body to the configured org and audits the write by hash
 * (ADR-0006). Universal.
 *
 * Keys are always addressed by their hash (`?hashed=true`): the raw key exists
 * once, in the create answer, and never becomes part of a URL. Unlike API
 * definitions and policies, key writes are live at once: no reload.
 */

import {
  settleStored,
  settleWrite,
  type StoredResult,
  type WriteResult,
} from '@/lib/designer/write';
import { ENVIRONMENT_HEADER, unwrap, type G2Client } from '@/lib/g2/client';
import { GatewayError } from '@/lib/g2/errors';
import { parseCreatedKey, type CreatedKey, type KeySession } from './session';

export type CreateKeyResult =
  ({ ok: true } & CreatedKey) | { ok: false; error: string; status?: number };

/**
 * `POST /g2/keys`. On success the result carries the raw key: hand it to the
 * one-time dialog and nowhere else (never state that outlives it, a URL, a
 * log or storage).
 */
export async function createKey(client: G2Client, draft: KeySession): Promise<CreateKeyResult> {
  let body: unknown;
  const written = await settleWrite(async () => {
    body = await unwrap(client.POST('/g2/keys', { body: draft }));
  });
  if (!written.ok) return written;
  try {
    return { ok: true, ...parseCreatedKey(body) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `PUT /g2/keys/{hash}?hashed=true`: replaces the stored session. */
export function saveKey(client: G2Client, hash: string, draft: KeySession): Promise<WriteResult> {
  return settleWrite(() =>
    unwrap(
      client.PUT('/g2/keys/{key}', {
        params: { path: { key: hash }, query: { hashed: true } },
        body: draft,
      }),
    ),
  );
}

/** `DELETE /g2/keys/{hash}?hashed=true`: the hard delete. */
export function deleteKey(client: G2Client, hash: string): Promise<WriteResult> {
  return settleWrite(() =>
    unwrap(
      client.DELETE('/g2/keys/{key}', {
        params: { path: { key: hash }, query: { hashed: true } },
      }),
    ),
  );
}

/** The session as stored right now, to diff against before saving; `null` if it is gone. */
export function fetchStoredKey(client: G2Client, hash: string): Promise<StoredResult<KeySession>> {
  return settleStored(() =>
    unwrap(
      client.GET('/g2/keys/{key}', { params: { path: { key: hash }, query: { hashed: true } } }),
    ),
  );
}

/** `session` with `active` set: the soft revoke, or undoing it. */
export function withActive(session: KeySession, active: boolean): KeySession {
  return { ...session, active };
}

// ---- rotate (ADR-0009) ------------------------------------------------------

/**
 * What `POST /api/g2/keys/{hash}/rotate` answers on a 201. The BFF's own
 * endpoint (g2way has no rotate), so this shape is the dashboard's:
 * `rotated`, or `partial` when the new key was created but the old one could
 * not be deleted, so both keys work. Any other status is the `{"error"}`
 * envelope and nothing changed.
 */
export type RotateAnswer =
  | { outcome: 'rotated'; key: string; key_hash: string; old_hash: string }
  | {
      outcome: 'partial';
      key: string;
      key_hash: string;
      old_hash: string;
      /** Why the old key is still there: the gateway's message, verbatim. */
      error: string;
    };

export type RotateResult =
  ({ ok: true } & RotateAnswer) | { ok: false; error: string; status?: number };

/** The BFF path of the rotate orchestration for key `hash`. */
export function rotatePath(hash: string): string {
  return `/g2/keys/${encodeURIComponent(hash)}/rotate`;
}

function parseRotateAnswer(body: unknown): RotateAnswer | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const strings = ['key', 'key_hash', 'old_hash'].every(
    (field) => typeof record[field] === 'string' && record[field] !== '',
  );
  if (!strings) return null;
  if (record.outcome === 'rotated') return record as RotateAnswer;
  if (record.outcome === 'partial' && typeof record.error === 'string') {
    return record as RotateAnswer;
  }
  return null;
}

/**
 * Rotates key `hash` in `environmentId` through the BFF. On success (either
 * outcome) the result carries the new raw key: the same one-time-dialog rule
 * as {@link createKey}.
 */
export async function rotateKey(
  environmentId: string,
  hash: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<RotateResult> {
  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.baseUrl ?? '/api'}${rotatePath(hash)}`, {
      method: 'POST',
      headers: { [ENVIRONMENT_HEADER]: environmentId, accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { message, status } = GatewayError.fromBody(response.status, body);
    return { ok: false, error: message, status };
  }
  const answer = parseRotateAnswer(body);
  return answer === null
    ? { ok: false, error: `rotate answered ${response.status} without a new key` }
    : { ok: true, ...answer };
}
