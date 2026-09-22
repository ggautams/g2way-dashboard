import { describe, expect, it } from 'vitest';
import { parseEnvironments } from './environments';
import { KEY_PAGE_SIZE, loadKey, loadKeyPage, loadPolicyChoices, mapLimit } from './keys';

// Stand-in org: the real one comes from config.
const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'dev-secret',
  G2_ORG_ID: 'acme',
});

const hashes = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(64, '0'));

/** A fake gateway listing `hashes`, answering every session read, one key corrupt. */
function gateway() {
  const urls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    urls.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/g2/keys') return Response.json({ keys: hashes });
    if (url.pathname === '/g2/policies') {
      return Response.json([{ policy_id: 'gold', name: 'Gold', active: false }]);
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    const hash = url.pathname.split('/').at(-1)!;
    if (hash === hashes[26]) return Response.json({ error: 'corrupt record' }, { status: 500 });
    return Response.json({ alias: `k${hashes.indexOf(hash)}` });
  }) as typeof globalThis.fetch;
  return { urls, fetch, peak: () => peak };
}

describe('loadKeyPage', () => {
  it('reads one session per shown hash only, a few at a time, by hash', async () => {
    const gw = gateway();
    const { environment, keys, fetchedAt } = await loadKeyPage('dev', 2, {
      registry,
      fetch: gw.fetch,
      now: () => 1_700_000_000_000,
    });
    expect(environment).toBe('dev');
    expect(fetchedAt).toBe(1_700_000_000_000);
    if (!keys.ok) throw new Error(keys.error);
    expect(keys.value).toMatchObject({ page: 2, pages: 3, total: 60 });
    expect(keys.value.items).toHaveLength(KEY_PAGE_SIZE);
    // The list, then exactly one read per row of this page.
    expect(gw.urls[0]).toBe('/g2/keys?org_id=acme');
    expect(gw.urls).toHaveLength(1 + KEY_PAGE_SIZE);
    expect(gw.urls[1]).toBe(`/g2/keys/${hashes[25]}?hashed=true&org_id=acme`);
    expect(gw.peak()).toBeLessThanOrEqual(5);
    // Rows keep the gateway's order; one failed read settles on its own row.
    expect(keys.value.items[0]).toEqual({
      hash: hashes[25],
      session: { ok: true, value: { alias: 'k25' } },
    });
    expect(keys.value.items[1].session).toEqual({
      ok: false,
      error: 'corrupt record',
      status: 500,
    });
  });

  it('settles a failed list with the gateway’s message', async () => {
    const fetch = (async () =>
      Response.json({ error: 'storage unavailable' }, { status: 503 })) as typeof globalThis.fetch;
    expect((await loadKeyPage('dev', 1, { registry, fetch })).keys).toEqual({
      ok: false,
      error: 'storage unavailable',
      status: 503,
    });
  });
});

describe('loadKey and loadPolicyChoices', () => {
  it('reads one key by hash', async () => {
    const gw = gateway();
    expect((await loadKey('dev', hashes[3], { registry, fetch: gw.fetch })).session).toEqual({
      ok: true,
      value: { alias: 'k3' },
    });
    expect(gw.urls).toEqual([`/g2/keys/${hashes[3]}?hashed=true&org_id=acme`]);
  });

  it('lists policies as choices, with g2way’s active default applied', async () => {
    const gw = gateway();
    expect(await loadPolicyChoices('dev', { registry, fetch: gw.fetch })).toEqual({
      ok: true,
      value: [{ id: 'gold', name: 'Gold', active: false }],
    });
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 8 - n));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 3, async (n: number) => n)).toEqual([]);
  });
});
