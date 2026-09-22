import { describe, expect, it, vi } from 'vitest';
import {
  BULK_MAX,
  applyKeyOp,
  chunkIds,
  parseBulkRequest,
  runBulk,
  runBulkChunked,
  type BulkRequest,
} from './ops';

describe('parseBulkRequest', () => {
  it('accepts key and policy requests, deduplicating ids', () => {
    expect(parseBulkRequest({ collection: 'keys', op: 'revoke', ids: ['a', 'a', 'b'] })).toEqual({
      ok: true,
      value: { collection: 'keys', op: 'revoke', ids: ['a', 'b'] },
    });
    expect(
      parseBulkRequest({ collection: 'keys', op: 'assign-policy', ids: ['a'], policy: ' gold ' }),
    ).toEqual({
      ok: true,
      value: { collection: 'keys', op: 'assign-policy', ids: ['a'], policy: 'gold' },
    });
    expect(parseBulkRequest({ collection: 'policies', op: 'delete', ids: ['p'] })).toMatchObject({
      ok: true,
    });
  });

  it('refuses what it cannot run', () => {
    const bad = [
      null,
      { collection: 'keys', op: 'revoke', ids: [] },
      { collection: 'keys', op: 'revoke', ids: 'a' },
      { collection: 'keys', op: 'rotate', ids: ['a'] },
      { collection: 'policies', op: 'revoke', ids: ['a'] },
      { collection: 'apis', op: 'delete', ids: ['a'] },
      { collection: 'keys', op: 'assign-policy', ids: ['a'] },
      { collection: 'keys', op: 'delete', ids: ['../x'] },
      {
        collection: 'keys',
        op: 'delete',
        ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => `k${i}`),
      },
    ];
    for (const body of bad) expect(parseBulkRequest(body).ok, JSON.stringify(body)).toBe(false);
  });

  it('carries a well-formed part of a chunked selection, and refuses a malformed one', () => {
    expect(
      parseBulkRequest({ collection: 'keys', op: 'revoke', ids: ['a'], part: { index: 2, of: 3 } }),
    ).toEqual({
      ok: true,
      value: { collection: 'keys', op: 'revoke', ids: ['a'], part: { index: 2, of: 3 } },
    });
    for (const part of [{ index: 0, of: 2 }, { index: 3, of: 2 }, { index: 1.5, of: 2 }, 'x']) {
      expect(parseBulkRequest({ collection: 'keys', op: 'revoke', ids: ['a'], part }).ok).toBe(
        false,
      );
    }
  });
});

describe('applyKeyOp', () => {
  const session = {
    alias: 'billing',
    rate: { requests: 1, per_seconds: 1 },
    hmac: { secret: 's' },
  };

  it('revokes and reactivates, keeping every other field', () => {
    expect(applyKeyOp(session, 'revoke')).toEqual({ next: { ...session, active: false } });
    expect(applyKeyOp({ ...session, active: false }, 'revoke')).toEqual({
      unchanged: 'already revoked',
    });
    expect(applyKeyOp({ ...session, active: false }, 'activate')).toEqual({
      next: { ...session, active: true },
    });
    // g2way's default is active.
    expect(applyKeyOp(session, 'activate')).toEqual({ unchanged: 'already active' });
  });

  it('assigns one policy, replacing any other (g2way applies at most one)', () => {
    expect(applyKeyOp(session, 'assign-policy', 'gold')).toEqual({
      next: { ...session, apply_policies: ['gold'] },
    });
    expect(applyKeyOp({ ...session, apply_policies: ['silver'] }, 'assign-policy', 'gold')).toEqual(
      { next: { ...session, apply_policies: ['gold'] } },
    );
    expect(applyKeyOp({ apply_policies: ['gold'] }, 'assign-policy', 'gold')).toEqual({
      unchanged: 'already applies gold',
    });
  });

  it('unassigns only the named policy, dropping the field when none is left', () => {
    expect(applyKeyOp({ ...session, apply_policies: ['gold'] }, 'unassign-policy', 'gold')).toEqual(
      { next: session },
    );
    expect(applyKeyOp({ apply_policies: ['silver'] }, 'unassign-policy', 'gold')).toEqual({
      unchanged: 'applies silver, not gold',
    });
    expect(applyKeyOp(session, 'unassign-policy', 'gold')).toEqual({
      unchanged: 'applies no policy',
    });
  });
});

describe('runBulk', () => {
  it('posts to the BFF with the environment header and passes an error envelope on', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'forbidden: nope' }, { status: 403 }));
    const result = await runBulk(
      'dev',
      { collection: 'policies', op: 'delete', ids: ['p'] },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result).toEqual({ ok: false, error: 'forbidden: nope', status: 403 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/g2/bulk');
    expect(new Headers(init.headers).get('x-g2-environment')).toBe('dev');
    expect(JSON.parse(String(init.body))).toEqual({
      collection: 'policies',
      op: 'delete',
      ids: ['p'],
    });
  });
});

describe('chunkIds', () => {
  it('splits in order into runs of at most the BFF limit', () => {
    const ids = Array.from({ length: 2 * BULK_MAX + 1 }, (_, i) => `k${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([BULK_MAX, BULK_MAX, 1]);
    expect(chunks.flat()).toEqual(ids);
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(() => chunkIds(['a'], 0)).toThrow(RangeError);
  });
});

describe('runBulkChunked', () => {
  const ids = Array.from({ length: 2 * BULK_MAX + 50 }, (_, i) => `k${i}`);
  const request: BulkRequest = { collection: 'keys', op: 'revoke', ids };

  /** A BFF answering each request with one `done` per id, or `refuse(n)` for the n-th request. */
  function bff(refuse: (n: number) => Response | null = () => null) {
    const bodies: BulkRequest[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as BulkRequest;
      bodies.push(body);
      const refused = refuse(bodies.length);
      if (refused !== null) return refused;
      return Response.json({
        collection: body.collection,
        op: body.op,
        results: body.ids.map((id) => ({ id, outcome: 'done', status: 200 })),
      });
    });
    return { bodies, fetch: fetch as unknown as typeof globalThis.fetch };
  }

  it('sends every id once, in requests of at most the BFF limit, each marked with its part', async () => {
    const server = bff();
    const result = await runBulkChunked('dev', request, { fetch: server.fetch });
    expect(server.bodies.map((body) => [body.ids.length, body.part])).toEqual([
      [BULK_MAX, { index: 1, of: 3 }],
      [BULK_MAX, { index: 2, of: 3 }],
      [50, { index: 3, of: 3 }],
    ]);
    expect(server.bodies.flatMap((body) => body.ids)).toEqual(ids);
    if (!result.ok) throw new Error(result.error);
    expect(result.results.map((r) => r.id)).toEqual(ids);
    expect(result.halted).toBeUndefined();
  });

  it('sends a selection that fits in one request unmarked, as runBulk would', async () => {
    const server = bff();
    await runBulkChunked(
      'dev',
      { ...request, ids: ids.slice(0, BULK_MAX) },
      { fetch: server.fetch },
    );
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0].part).toBeUndefined();
  });

  it('stops at a request refused whole, reporting what ran and what was never sent', async () => {
    const server = bff((n) =>
      n === 2 ? Response.json({ error: 'audit log unavailable' }, { status: 503 }) : null,
    );
    const result = await runBulkChunked('dev', request, { fetch: server.fetch });
    expect(server.bodies).toHaveLength(2);
    if (!result.ok) throw new Error(result.error);
    expect(result.results).toHaveLength(BULK_MAX);
    expect(result.halted).toEqual({
      error: 'audit log unavailable',
      status: 503,
      notSent: ids.slice(BULK_MAX),
    });
  });

  it('answers the refusal itself when the first request is refused: nothing ran', async () => {
    const server = bff(() => Response.json({ error: 'forbidden: nope' }, { status: 403 }));
    const result = await runBulkChunked('dev', request, { fetch: server.fetch });
    expect(result).toEqual({ ok: false, error: 'forbidden: nope', status: 403 });
    expect(server.bodies).toHaveLength(1);
  });
});
