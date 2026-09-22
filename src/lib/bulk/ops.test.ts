import { describe, expect, it, vi } from 'vitest';
import { BULK_MAX, applyKeyOp, parseBulkRequest, runBulk } from './ops';

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
