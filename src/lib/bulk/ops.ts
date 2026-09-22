/**
 * Bulk operations on keys and policies: the request the browser sends to
 * `POST /api/g2/bulk`, the per-item answer, and what each key operation does
 * to a session. Universal and pure, except {@link runBulk}, the browser's call.
 *
 * g2way has no batch endpoint, so the BFF (`lib/g2/bulk.ts`) makes one
 * ordinary gateway call per item, each through the audited proxy, and reports
 * each item on its own. Keys are addressed by hash only; no raw key is
 * involved at any point.
 */

import { ENVIRONMENT_HEADER } from '@/lib/g2/client';
import { GatewayError } from '@/lib/g2/errors';
import type { KeySession } from '@/lib/keys/session';

/** The most items one bulk request may name. */
export const BULK_MAX = 100;

export const KEY_BULK_OPS = [
  'revoke',
  'activate',
  'delete',
  'assign-policy',
  'unassign-policy',
] as const;
export type KeyBulkOp = (typeof KEY_BULK_OPS)[number];
export const POLICY_BULK_OPS = ['delete'] as const;
export type PolicyBulkOp = (typeof POLICY_BULK_OPS)[number];

/**
 * Which request of a selection larger than {@link BULK_MAX} this is (1-based),
 * sent by {@link runBulkChunked} so each summary audit row says it is a part.
 */
export type BulkPart = { index: number; of: number };

export type BulkRequest =
  | { collection: 'keys'; op: KeyBulkOp; ids: string[]; policy?: string; part?: BulkPart }
  | { collection: 'policies'; op: PolicyBulkOp; ids: string[]; part?: BulkPart };

export type BulkItemResult =
  | { id: string; outcome: 'done'; status: number }
  | { id: string; outcome: 'unchanged'; reason: string }
  | {
      id: string;
      outcome: 'failed';
      /** The gateway's `{"error"}` message verbatim, or the BFF's own. */
      error: string;
      status?: number;
    };

export type BulkAnswer = {
  collection: BulkRequest['collection'];
  op: string;
  results: BulkItemResult[];
};

/** A chunked run that stopped: a later request was refused whole, after earlier ones ran. */
export type BulkHalt = { error: string; status?: number; notSent: string[] };

export type ParsedBulk = { ok: true; value: BulkRequest } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks a bulk request body; the error is the BFF's 400 message. */
export function parseBulkRequest(body: unknown): ParsedBulk {
  if (!isRecord(body)) return { ok: false, error: 'invalid bulk request: not a JSON object' };
  const { collection, op, ids, policy } = body;
  const part = parsePart(body.part);
  if (part === null) {
    return {
      ok: false,
      error: 'invalid bulk request: `part` must be {index, of} with 1 ≤ index ≤ of',
    };
  }
  const withPart = part === undefined ? {} : { part };
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    return { ok: false, error: 'invalid bulk request: `ids` must be an array of strings' };
  }
  const unique = [...new Set(ids as string[])];
  if (unique.length === 0) return { ok: false, error: 'invalid bulk request: no items selected' };
  if (unique.length > BULK_MAX) {
    return { ok: false, error: `invalid bulk request: at most ${BULK_MAX} items at once` };
  }
  const bad = unique.find((id) => id === '' || /[/?#]/.test(id));
  if (bad !== undefined) return { ok: false, error: `invalid bulk request: not an id: ${bad}` };

  if (collection === 'policies') {
    if (!(POLICY_BULK_OPS as readonly unknown[]).includes(op)) {
      return {
        ok: false,
        error: `invalid bulk request: policies support ${POLICY_BULK_OPS.join(', ')}`,
      };
    }
    return { ok: true, value: { collection, op: op as PolicyBulkOp, ids: unique, ...withPart } };
  }
  if (collection !== 'keys') {
    return { ok: false, error: 'invalid bulk request: `collection` must be keys or policies' };
  }
  if (!(KEY_BULK_OPS as readonly unknown[]).includes(op)) {
    return { ok: false, error: `invalid bulk request: keys support ${KEY_BULK_OPS.join(', ')}` };
  }
  const keyOp = op as KeyBulkOp;
  if (keyOp === 'assign-policy' || keyOp === 'unassign-policy') {
    if (typeof policy !== 'string' || policy.trim() === '') {
      return { ok: false, error: `invalid bulk request: ${keyOp} needs a \`policy\`` };
    }
    return {
      ok: true,
      value: { collection, op: keyOp, ids: unique, policy: policy.trim(), ...withPart },
    };
  }
  return { ok: true, value: { collection, op: keyOp, ids: unique, ...withPart } };
}

/** `undefined` when absent, `null` when malformed. */
function parsePart(value: unknown): BulkPart | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { index, of } = value;
  if (!Number.isInteger(index) || !Number.isInteger(of)) return null;
  const [i, n] = [index as number, of as number];
  return i >= 1 && i <= n && n <= 1000 ? { index: i, of: n } : null;
}

export type SessionChange = { next: KeySession } | { unchanged: string };

/**
 * What a key operation other than delete makes of the stored `session`: the
 * session to `PUT`, or why nothing needs writing. Every other field is kept.
 */
export function applyKeyOp(
  session: KeySession,
  op: Exclude<KeyBulkOp, 'delete'>,
  policy?: string,
): SessionChange {
  const active = session.active ?? true;
  const applied = session.apply_policies ?? [];
  switch (op) {
    case 'revoke':
      return active ? { next: { ...session, active: false } } : { unchanged: 'already revoked' };
    case 'activate':
      return active ? { unchanged: 'already active' } : { next: { ...session, active: true } };
    case 'assign-policy':
      if (policy === undefined) return { unchanged: 'no policy named' };
      return applied.length === 1 && applied[0] === policy
        ? { unchanged: `already applies ${policy}` }
        : // g2way applies at most one policy per key: assigning replaces any other.
          { next: { ...session, apply_policies: [policy] } };
    case 'unassign-policy': {
      if (policy === undefined || !applied.includes(policy)) {
        return {
          unchanged:
            applied.length === 0
              ? 'applies no policy'
              : `applies ${applied.join(', ')}, not ${policy ?? 'that policy'}`,
        };
      }
      const rest = applied.filter((id) => id !== policy);
      const next = { ...session };
      if (rest.length === 0) delete next.apply_policies;
      else next.apply_policies = rest;
      return { next };
    }
  }
}

/** Plain words for an operation, for review dialogs and audit notes. */
export function describeBulkOp(
  request: Pick<BulkRequest, 'collection' | 'op'> & { policy?: string },
): string {
  if (request.collection === 'policies') return 'delete';
  switch (request.op) {
    case 'assign-policy':
      return `apply policy ${request.policy ?? '?'}`;
    case 'unassign-policy':
      return `remove policy ${request.policy ?? '?'}`;
    default:
      return request.op;
  }
}

export type BulkCallResult =
  ({ ok: true; halted?: BulkHalt } & BulkAnswer) | { ok: false; error: string; status?: number };

/** Sends `request` for environment `environmentId` through the BFF. */
export async function runBulk(
  environmentId: string,
  request: BulkRequest,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<BulkCallResult> {
  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.baseUrl ?? '/api'}/g2/bulk`, {
      method: 'POST',
      headers: {
        [ENVIRONMENT_HEADER]: environmentId,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
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
  if (!isRecord(body) || !Array.isArray(body.results)) {
    return { ok: false, error: `bulk answered ${response.status} without per-item results` };
  }
  return { ok: true, ...(body as BulkAnswer) };
}

/** `ids` in order, in runs of at most `size` (the BFF's {@link BULK_MAX}). */
export function chunkIds<T>(ids: readonly T[], size: number = BULK_MAX): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size ${size}`);
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/**
 * {@link runBulk} for any number of items: one BFF request per
 * {@link BULK_MAX} items, one after another, each marked with its `part` so
 * its summary audit row says so. A selection that fits in one request is sent
 * unmarked, exactly as {@link runBulk} would.
 *
 * Per-item failures never stop the run (the BFF reports them). A request
 * refused whole (400, 403, 503) stops it: before anything ran, the answer is
 * that refusal; after, it is the results so far with `halted` naming what was
 * never sent.
 */
export async function runBulkChunked(
  environmentId: string,
  request: BulkRequest,
  options: { baseUrl?: string; fetch?: typeof fetch; size?: number } = {},
): Promise<BulkCallResult> {
  const chunks = chunkIds([...new Set(request.ids)], options.size ?? BULK_MAX);
  if (chunks.length <= 1) return runBulk(environmentId, request, options);
  const results: BulkItemResult[] = [];
  for (const [i, ids] of chunks.entries()) {
    const answer = await runBulk(
      environmentId,
      { ...request, ids, part: { index: i + 1, of: chunks.length } },
      options,
    );
    if (!answer.ok) {
      if (i === 0) return answer;
      return {
        ok: true,
        collection: request.collection,
        op: request.op,
        results,
        halted: {
          error: answer.error,
          ...(answer.status === undefined ? {} : { status: answer.status }),
          notSent: chunks.slice(i).flat(),
        },
      };
    }
    results.push(...answer.results);
  }
  return { ok: true, collection: request.collection, op: request.op, results };
}
