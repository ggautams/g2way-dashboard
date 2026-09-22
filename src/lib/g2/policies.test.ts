import { describe, expect, it } from 'vitest';
import { UnknownEnvironmentError, parseEnvironments } from './environments';
import { loadPolicies, loadPolicy } from './policies';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'dev-secret',
  G2_ENV_PROD_URL: 'http://gw-prod:9696',
  G2_ENV_PROD_SECRET: 'prod-secret',
  G2_ORG_ID: 'acme',
});

function gateway(reply: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new Request(input, init).url);
    return reply();
  }) as typeof globalThis.fetch;
  return { urls, fetch };
}

const gold = { policy_id: 'gold', name: 'Gold', access: {} };

describe('loadPolicies', () => {
  it('lists the environment’s policies, scoped to the configured org', async () => {
    const gw = gateway(() => Response.json([gold]));
    expect(await loadPolicies('prod', { registry, fetch: gw.fetch })).toEqual({
      environment: 'prod',
      policies: { ok: true, value: [gold] },
    });
    expect(gw.urls).toEqual(['http://gw-prod:9696/g2/policies?org_id=acme']);
  });

  it('settles the gateway’s own error message verbatim', async () => {
    const gw = gateway(() => Response.json({ error: 'storage unavailable' }, { status: 503 }));
    expect((await loadPolicies('dev', { registry, fetch: gw.fetch })).policies).toEqual({
      ok: false,
      error: 'storage unavailable',
      status: 503,
    });
  });

  it('settles an unreachable gateway, and throws on an unknown environment', async () => {
    const gw = gateway(() => Promise.reject(new TypeError('fetch failed')));
    expect((await loadPolicies('dev', { registry, fetch: gw.fetch })).policies.ok).toBe(false);
    await expect(loadPolicies('nope', { registry })).rejects.toBeInstanceOf(
      UnknownEnvironmentError,
    );
  });
});

describe('loadPolicy', () => {
  it('fetches one policy by id, path-encoded and org-scoped', async () => {
    const gw = gateway(() => Response.json(gold));
    expect(
      (await loadPolicy('dev', 'a b', 'editor', { registry, fetch: gw.fetch })).policy,
    ).toEqual({
      ok: true,
      value: gold,
    });
    expect(gw.urls).toEqual(['http://gw-dev:9696/g2/policies/a%20b?org_id=acme']);
  });

  it('settles a 404 with its status, for the page to turn into not-found', async () => {
    const gw = gateway(() => Response.json({ error: 'policy not found' }, { status: 404 }));
    expect((await loadPolicy('dev', 'x', 'editor', { registry, fetch: gw.fetch })).policy).toEqual({
      ok: false,
      error: 'policy not found',
      status: 404,
    });
  });
});
