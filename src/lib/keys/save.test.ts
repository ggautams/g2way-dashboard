import { describe, expect, it } from 'vitest';
import { bffClient } from '@/lib/g2/client';
import { createKey, deleteKey, fetchStoredKey, rotateKey, saveKey, withActive } from './save';
import type { KeySession } from './session';

const HASH = 'b'.repeat(64);
const RAW = 'raw-key-shown-once';
const session: KeySession = { alias: 'mobile', rate: { requests: 10, per_seconds: 60 } };

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
  return { requests, fetch, client: bffClient('prod', { baseUrl: 'http://dash/api', fetch }) };
}

describe('createKey', () => {
  it('posts the session through the BFF and hands back the raw key and hash', async () => {
    const { requests, client } = bff(() =>
      Response.json({ key: RAW, key_hash: HASH }, { status: 201 }),
    );
    expect(await createKey(client, session)).toEqual({ ok: true, key: RAW, key_hash: HASH });
    expect(requests).toMatchObject([
      { method: 'POST', url: 'http://dash/api/g2/keys', env: 'prod' },
    ]);
    expect(JSON.parse(requests[0].body)).toEqual(session);
  });

  it('returns the gateway’s refusal verbatim, with its status', async () => {
    const error = 'invalid key session: `quota.max` must be greater than zero';
    const { client } = bff(() => Response.json({ error }, { status: 400 }));
    expect(await createKey(client, session)).toEqual({ ok: false, error, status: 400 });
  });

  it('refuses a 201 without the key, rather than showing nothing', async () => {
    const { client } = bff(() => Response.json({ key_hash: HASH }, { status: 201 }));
    const result = await createKey(client, session);
    expect(result.ok).toBe(false);
  });
});

describe('writes by hash', () => {
  it('always addresses the key by hash, never raw', async () => {
    const { requests, client } = bff(() => Response.json({ id: HASH, action: 'modified' }));
    expect(await saveKey(client, HASH, withActive(session, false))).toEqual({ ok: true });
    expect(await deleteKey(client, HASH)).toEqual({ ok: true });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ['PUT', `http://dash/api/g2/keys/${HASH}?hashed=true`],
      ['DELETE', `http://dash/api/g2/keys/${HASH}?hashed=true`],
    ]);
    expect(JSON.parse(requests[0].body)).toEqual({ ...session, active: false });
  });

  it('reads what is stored; a 404 means gone', async () => {
    const found = bff(() => Response.json(session));
    expect(await fetchStoredKey(found.client, HASH)).toEqual({ ok: true, stored: session });
    expect(found.requests[0].url).toBe(`http://dash/api/g2/keys/${HASH}?hashed=true`);
    const gone = bff(() => Response.json({ error: 'key not found' }, { status: 404 }));
    expect(await fetchStoredKey(gone.client, HASH)).toEqual({ ok: true, stored: null });
  });
});

describe('rotateKey', () => {
  it('posts to the BFF’s rotate route for the hash, naming the environment', async () => {
    const answer = { outcome: 'rotated', key: RAW, key_hash: 'c'.repeat(64), old_hash: HASH };
    const { requests, fetch } = bff(() => Response.json(answer, { status: 201 }));
    expect(await rotateKey('prod', HASH, { baseUrl: 'http://dash/api', fetch })).toEqual({
      ok: true,
      ...answer,
    });
    expect(requests).toMatchObject([
      { method: 'POST', url: `http://dash/api/g2/keys/${HASH}/rotate`, env: 'prod', body: '' },
    ]);
  });

  it('passes a partial rotation through, with why the old key survived', async () => {
    const answer = {
      outcome: 'partial',
      key: RAW,
      key_hash: 'c'.repeat(64),
      old_hash: HASH,
      error: 'storage unavailable',
    };
    const { fetch } = bff(() => Response.json(answer, { status: 201 }));
    expect(await rotateKey('prod', HASH, { baseUrl: 'http://dash/api', fetch })).toEqual({
      ok: true,
      ...answer,
    });
  });

  it('quotes a refusal verbatim', async () => {
    const error = 'forbidden: the editor role lacks the keys:write permission (key rotate)';
    const { fetch } = bff(() => Response.json({ error }, { status: 403 }));
    expect(await rotateKey('prod', HASH, { baseUrl: 'http://dash/api', fetch })).toEqual({
      ok: false,
      error,
      status: 403,
    });
  });

  it('reports a network failure and a nonsense answer', async () => {
    const down = bff(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(
      await rotateKey('prod', HASH, { fetch: down.fetch, baseUrl: 'http://dash/api' }),
    ).toEqual({
      ok: false,
      error: 'Failed to fetch',
    });
    const odd = bff(() => Response.json({ outcome: 'rotated' }, { status: 201 }));
    expect((await rotateKey('prod', HASH, { fetch: odd.fetch, baseUrl: 'http://x/api' })).ok).toBe(
      false,
    );
  });
});
