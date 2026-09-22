import { describe, expect, it } from 'vitest';
import { bffClient } from '@/lib/g2/client';
import type { ApiDefinition } from './list';
import { deleteApi, fetchStored, saveApi, saveBlocker, saveDiff } from './save';

const api: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://orders:80',
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

describe('saveApi', () => {
  it('creates with POST and replaces with PUT, through the BFF, naming the environment', async () => {
    const { requests, client } = bff(() => Response.json({ id: 'orders', action: 'added' }));
    expect(await saveApi(client, api, true)).toEqual({ ok: true });
    expect(await saveApi(client, { ...api, name: 'Orders v2' }, false)).toEqual({ ok: true });
    expect(requests.map(({ method, url, env }) => [method, url, env])).toEqual([
      ['POST', 'http://dash/api/g2/apis', 'prod'],
      ['PUT', 'http://dash/api/g2/apis/orders', 'prod'],
    ]);
    expect(JSON.parse(requests[1].body)).toEqual({ ...api, name: 'Orders v2' });
  });

  it('returns the gateway’s refusal verbatim, with its status', async () => {
    const { client } = bff(() =>
      Response.json({ error: 'api orders already exists; use PUT' }, { status: 409 }),
    );
    expect(await saveApi(client, api, true)).toEqual({
      ok: false,
      error: 'api orders already exists; use PUT',
      status: 409,
    });
  });

  it('reports a network failure without a status', async () => {
    const { client } = bff(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await saveApi(client, api, false)).toEqual({ ok: false, error: 'Failed to fetch' });
  });
});

describe('deleteApi and fetchStored', () => {
  it('deletes by id', async () => {
    const { requests, client } = bff(() => Response.json({ id: 'a b', action: 'deleted' }));
    expect(await deleteApi(client, 'a b')).toEqual({ ok: true });
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: 'http://dash/api/g2/apis/a%20b' });
  });

  it('reads what is stored, treating 404 as gone', async () => {
    expect(await fetchStored(bff(() => Response.json(api)).client, 'orders')).toEqual({
      ok: true,
      stored: api,
    });
    const gone = bff(() => Response.json({ error: 'api not found' }, { status: 404 }));
    expect(await fetchStored(gone.client, 'orders')).toEqual({ ok: true, stored: null });
    const down = bff(() => Response.json({ error: 'storage unavailable' }, { status: 503 }));
    expect(await fetchStored(down.client, 'orders')).toEqual({
      ok: false,
      error: 'storage unavailable',
    });
  });
});

describe('saveDiff and saveBlocker', () => {
  it('diffs a creation against nothing and an edit field by field', () => {
    expect(saveDiff(null, api).map((c) => c.kind)).toEqual(['added', 'added', 'added', 'added']);
    expect(saveDiff(api, { ...api, active: false })).toEqual([
      { kind: 'added', path: 'active', after: false },
    ]);
  });

  it('refuses an edit that changes the id', () => {
    expect(saveBlocker(api, api)).toBeNull();
    expect(saveBlocker(null, { ...api, api_id: 'anything' })).toBeNull();
    expect(saveBlocker(api, { ...api, api_id: 'other' })).toMatch(/cannot change/);
  });
});
