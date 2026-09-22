import { describe, expect, it } from 'vitest';
import { loadApi, loadApis } from './apis';
import { UnknownEnvironmentError, parseEnvironments } from './environments';

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

describe('loadApis', () => {
  it('lists the environment’s definitions, scoped to the configured org', async () => {
    const api = { api_id: 'a', name: 'A', listen_path: '/a/', target_url: 'http://a' };
    const gw = gateway(() => Response.json([api]));
    expect(await loadApis('prod', { registry, fetch: gw.fetch })).toEqual({
      environment: 'prod',
      apis: { ok: true, value: [api] },
    });
    expect(gw.urls).toEqual(['http://gw-prod:9696/g2/apis?org_id=acme']);
  });

  it('settles the gateway’s own error message verbatim', async () => {
    const gw = gateway(() => Response.json({ error: 'storage unavailable' }, { status: 503 }));
    expect((await loadApis('dev', { registry, fetch: gw.fetch })).apis).toEqual({
      ok: false,
      error: 'storage unavailable',
      status: 503,
    });
  });

  it('settles an unreachable gateway, and throws on an unknown environment', async () => {
    const gw = gateway(() => Promise.reject(new TypeError('fetch failed')));
    expect((await loadApis('dev', { registry, fetch: gw.fetch })).apis.ok).toBe(false);
    await expect(loadApis('nope', { registry })).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });
});

describe('loadApi', () => {
  it('fetches one definition by id, path-encoded and org-scoped', async () => {
    const api = { api_id: 'a b', name: 'A', listen_path: '/a/', target_url: 'http://a' };
    const gw = gateway(() => Response.json(api));
    expect((await loadApi('dev', 'a b', { registry, fetch: gw.fetch })).api).toEqual({
      ok: true,
      value: api,
    });
    expect(gw.urls).toEqual(['http://gw-dev:9696/g2/apis/a%20b?org_id=acme']);
  });

  it('settles a 404 with its status, for the page to turn into not-found', async () => {
    const gw = gateway(() => Response.json({ error: 'api not found' }, { status: 404 }));
    expect((await loadApi('dev', 'x', { registry, fetch: gw.fetch })).api).toEqual({
      ok: false,
      error: 'api not found',
      status: 404,
    });
  });
});
