import { describe, expect, it } from 'vitest';
import { UnknownEnvironmentError, parseEnvironments } from './environments';
import { loadGatewayStatus } from './gateway-status';
import { nodeBody } from './node.fixture';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'dev-secret',
  G2_ENV_PROD_URL: 'http://gw-prod:9696',
  G2_ENV_PROD_SECRET: 'prod-secret',
});

type Route = (url: URL) => Response;

function fakeGateway(routes: Record<string, Route>) {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const route = routes[url.pathname];
    return route ? route(url) : Response.json({ error: 'not found' }, { status: 404 });
  };
  return fetch as typeof globalThis.fetch;
}

const healthy = {
  '/g2/health': () => Response.json({ status: 'pass' }),
  '/g2/version': () => Response.json({ version: '0.9.0' }),
  '/g2/node': () => Response.json(nodeBody()),
};

describe('loadGatewayStatus', () => {
  it('loads all three endpoints of the chosen environment', async () => {
    const status = await loadGatewayStatus('prod', {
      registry,
      fetch: fakeGateway(healthy),
      now: () => 42,
    });
    expect(status.environment).toBe('prod');
    expect(status.fetchedAt).toBe(42);
    expect(status.health).toEqual({ ok: true, value: { status: 'pass' } });
    expect(status.version).toEqual({ ok: true, value: { version: '0.9.0' } });
    expect(status.node.ok && status.node.value.apis.map((a) => a.api_id)).toEqual([
      'orders',
      'catalog',
    ]);
  });

  it('resolves the default environment id when none is named', async () => {
    const status = await loadGatewayStatus(undefined, { registry, fetch: fakeGateway(healthy) });
    expect(status.environment).toBe('dev');
  });

  it('settles each endpoint on its own, keeping the gateway message verbatim', async () => {
    const status = await loadGatewayStatus('dev', {
      registry,
      fetch: fakeGateway({
        ...healthy,
        '/g2/version': () => Response.json({ error: 'forbidden' }, { status: 403 }),
        '/g2/node': () =>
          Response.json({ error: 'node status unavailable on this deployment' }, { status: 503 }),
      }),
    });
    expect(status.health.ok).toBe(true);
    expect(status.version).toEqual({ ok: false, error: 'forbidden', status: 403 });
    expect(status.node).toEqual({
      ok: false,
      error: 'node status unavailable on this deployment',
      status: 503,
    });
  });

  it('reports an unreachable gateway and a changed payload without throwing', async () => {
    const down = await loadGatewayStatus('dev', {
      registry,
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      }) as typeof fetch,
    });
    for (const outcome of [down.health, down.version, down.node]) {
      expect(outcome).toEqual({
        ok: false,
        error: 'gateway unreachable (environment dev): fetch failed (connect ECONNREFUSED)',
      });
    }

    const moved = await loadGatewayStatus('dev', {
      registry,
      fetch: fakeGateway({ ...healthy, '/g2/node': () => Response.json({ apis: [] }) }),
    });
    expect(moved.node).toEqual({
      ok: false,
      error: 'GET /g2/node: expected version to be a string, got undefined',
    });
  });

  it('throws registry errors: those are dashboard config, not gateway state', async () => {
    await expect(loadGatewayStatus('qa', { registry })).rejects.toBeInstanceOf(
      UnknownEnvironmentError,
    );
  });
});
