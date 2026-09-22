import { describe, expect, it } from 'vitest';
import { saveDiff } from '@/lib/designer/write';
import { bffClient } from '@/lib/g2/client';
import type { Policy } from './list';
import { deletePolicy, fetchStoredPolicy, policySaveBlocker, savePolicy } from './save';

const gold: Policy = {
  policy_id: 'gold',
  name: 'Gold',
  rate: { requests: 100, per_seconds: 60 },
  access: { orders: {} },
};

/** A fake BFF: records each request and answers with `reply`. */
function bff(reply: () => Response | Promise<Response>) {
  const requests: { method: string; url: string; env: string | null; body: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      env: request.headers.get('x-g2-environment'),
      body: await request.text(),
    });
    return reply();
  }) as typeof globalThis.fetch;
  return { requests, client: bffClient('prod', { baseUrl: 'http://dash/api', fetch }) };
}

describe('savePolicy', () => {
  it('creates with POST and replaces with PUT, through the BFF, naming the environment', async () => {
    const { requests, client } = bff(() => Response.json({ id: 'gold', action: 'added' }));
    expect(await savePolicy(client, gold, true)).toEqual({ ok: true });
    expect(await savePolicy(client, { ...gold, active: false }, false)).toEqual({ ok: true });
    expect(requests.map(({ method, url, env }) => [method, url, env])).toEqual([
      ['POST', 'http://dash/api/g2/policies', 'prod'],
      ['PUT', 'http://dash/api/g2/policies/gold', 'prod'],
    ]);
    expect(JSON.parse(requests[0].body)).toEqual(gold);
    expect(JSON.parse(requests[1].body)).toEqual({ ...gold, active: false });
  });

  it('returns the gateway’s refusal verbatim, with its status', async () => {
    const error = 'invalid policy gold: `rate.requests` must be greater than zero';
    const { client } = bff(() => Response.json({ error }, { status: 400 }));
    expect(await savePolicy(client, gold, false)).toEqual({ ok: false, error, status: 400 });
  });

  it('reports a network failure without a status', async () => {
    const { client } = bff(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await savePolicy(client, gold, true)).toEqual({ ok: false, error: 'Failed to fetch' });
  });
});

describe('deletePolicy and fetchStoredPolicy', () => {
  it('deletes by id, path-encoded', async () => {
    const { requests, client } = bff(() => Response.json({ id: 'a b', action: 'deleted' }));
    expect(await deletePolicy(client, 'a b')).toEqual({ ok: true });
    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      url: 'http://dash/api/g2/policies/a%20b',
    });
  });

  it('reads what is stored, treating 404 as gone', async () => {
    expect(await fetchStoredPolicy(bff(() => Response.json(gold)).client, 'gold')).toEqual({
      ok: true,
      stored: gold,
    });
    const gone = bff(() => Response.json({ error: 'policy not found' }, { status: 404 }));
    expect(await fetchStoredPolicy(gone.client, 'gold')).toEqual({ ok: true, stored: null });
    const down = bff(() => Response.json({ error: 'storage unavailable' }, { status: 503 }));
    expect(await fetchStoredPolicy(down.client, 'gold')).toEqual({
      ok: false,
      error: 'storage unavailable',
    });
  });
});

describe('the save preview and blocker', () => {
  it('diffs an edit field by field, access included', () => {
    expect(saveDiff(gold, { ...gold, rate: null, access: { orders: {}, billing: {} } })).toEqual(
      expect.arrayContaining([
        { kind: 'added', path: 'access.billing', after: {} },
        expect.objectContaining({ path: 'rate' }),
      ]),
    );
  });

  it('refuses an edit that changes the id', () => {
    expect(policySaveBlocker(gold, gold)).toBeNull();
    expect(policySaveBlocker(null, { ...gold, policy_id: 'other' })).toBeNull();
    expect(policySaveBlocker(gold, { ...gold, policy_id: 'other' })).toMatch(/cannot change/);
  });
});
