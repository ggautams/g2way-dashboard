import { describe, expect, it } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { parseEnvironments } from './environments';
import { resolveKeyMatches } from './key-matches';
import { KEY_SCAN_LIMIT } from './keys';

// Stand-in org: the real one comes from config.
const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'dev-secret',
  G2_ORG_ID: 'acme',
});

const HMAC = 'hmac-secret-never-to-the-browser';
const many = Array.from({ length: KEY_SCAN_LIMIT + 30 }, (_, i) =>
  i.toString(16).padStart(64, '0'),
);

/** Key i has alias `k<i>` and an hmac secret; even keys are revoked; key 4 is corrupt. */
const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(new Request(input, init).url);
  if (url.pathname === '/g2/keys') return Response.json({ keys: many });
  const i = many.indexOf(url.pathname.split('/').at(-1)!);
  if (i === 4) return Response.json({ error: 'corrupt record' }, { status: 500 });
  return Response.json({ alias: `k${i}`, active: i % 2 !== 0, hmac: { secret: HMAC } });
}) as typeof globalThis.fetch;

const deps = {
  registry,
  fetch,
  now: () => 1_700_000_000_000,
  labelsFor: async () => new Map([[many[1], { label: 'Checkout', owner: 'team-a' }]]),
};
const as = (role: Role) => ({ role });

describe('resolveKeyMatches', () => {
  it('resolves every match of the filter as display rows, saying where it stopped', async () => {
    const answer = await resolveKeyMatches(as('admin'), 'dev', { state: 'revoked' }, deps);
    if (!answer.ok) throw new Error(answer.error);
    // Even keys among the 200 read, minus the unreadable key 4.
    expect(answer.items).toHaveLength(KEY_SCAN_LIMIT / 2 - 1);
    expect(answer.items.every((row) => row.state === 'revoked')).toBe(true);
    expect(answer.items.map((row) => row.hash)).not.toContain(many[4]);
    expect(answer).toMatchObject({
      environment: 'dev',
      unreadable: 1,
      truncatedAt: KEY_SCAN_LIMIT,
      labelsError: null,
      resolvedAt: 1_700_000_000_000,
      scan: { total: many.length, scanned: KEY_SCAN_LIMIT, unchecked: 1 },
    });
    // Display strings only: no session, so no secret, reaches the browser.
    expect(JSON.stringify(answer)).not.toContain(HMAC);
  });

  it('carries labels onto the rows and reports no truncation when everything was read', async () => {
    const answer = await resolveKeyMatches(
      as('owner'),
      'dev',
      { q: 'checkout' },
      {
        ...deps,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === '/g2/keys') return Response.json({ keys: many.slice(0, 3) });
          return Response.json({ alias: 'x' });
        }) as typeof globalThis.fetch,
      },
    );
    if (!answer.ok) throw new Error(answer.error);
    expect(answer.items.map((row) => [row.hash, row.title, row.owner])).toEqual([
      [many[1], 'Checkout', 'team-a'],
    ]);
    expect(answer.truncatedAt).toBeNull();
    expect(answer.unreadable).toBe(0);
  });

  it('refuses a role without keys:write, a missing filter and a malformed one', async () => {
    expect(await resolveKeyMatches(as('editor'), 'dev', { state: 'revoked' }, deps)).toEqual({
      ok: false,
      error: 'forbidden: the editor role lacks the keys:write permission',
    });
    for (const input of [{}, null, [], { q: 7 }, { state: 'all' }]) {
      expect(await resolveKeyMatches(as('admin'), 'dev', input, deps)).toMatchObject({
        ok: false,
      });
    }
  });

  it('passes the gateway’s message on, and names an unknown environment', async () => {
    const failing = (async () =>
      Response.json({ error: 'storage unavailable' }, { status: 503 })) as typeof globalThis.fetch;
    expect(
      await resolveKeyMatches(as('admin'), 'dev', { q: 'x' }, { ...deps, fetch: failing }),
    ).toEqual({ ok: false, error: 'GET /g2/keys failed: storage unavailable (HTTP 503)' });
    expect(await resolveKeyMatches(as('admin'), 'prod', { q: 'x' }, deps)).toMatchObject({
      ok: false,
    });
  });
});
