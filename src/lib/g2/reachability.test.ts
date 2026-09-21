import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnvironments } from './environments';
import { PROBE_TTL_MS, probeEnvironments } from './reachability';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'dev-secret',
  G2_ENV_PROD_URL: 'http://gw-prod:9696',
  G2_ENV_PROD_SECRET: 'prod-secret',
});

/** A fetch answering per host, counting calls. */
function fakeFetch(byHost: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    calls.push(`${url.host}${url.pathname}`);
    return byHost[url.hostname]();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ok = () => Response.json({ version: '0.9.0' });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('probeEnvironments', () => {
  it('probes every environment with an authenticated call', async () => {
    const { fetch, calls } = fakeFetch({ 'gw-dev': ok, 'gw-prod': ok });
    const result = await probeEnvironments({ registry, fetch, cache: new Map() });
    expect(calls.sort()).toEqual(['gw-dev:9696/g2/version', 'gw-prod:9696/g2/version']);
    expect(result).toEqual({
      kind: 'probed',
      probes: [
        { environment: { id: 'dev', label: 'dev', isDefault: true }, state: 'ok' },
        { environment: { id: 'prod', label: 'prod', isDefault: false }, state: 'ok' },
      ],
    });
  });

  it('reports a network failure as unreachable, with the real cause', async () => {
    const { fetch } = fakeFetch({
      'gw-dev': () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      },
      'gw-prod': () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    const result = await probeEnvironments({ registry, fetch, cache: new Map() });
    expect(result.kind === 'probed' && result.probes).toEqual([
      expect.objectContaining({
        state: 'unreachable',
        message: 'gateway unreachable (environment dev): fetch failed (connect ECONNREFUSED)',
      }),
      expect.objectContaining({
        state: 'unreachable',
        message: expect.stringContaining('timeout'),
      }),
    ]);
  });

  it('tells a refused secret from other gateway errors, keeping the message verbatim', async () => {
    const { fetch } = fakeFetch({
      'gw-dev': () => Response.json({ error: 'forbidden' }, { status: 403 }),
      'gw-prod': () => Response.json({ error: 'redis unavailable' }, { status: 503 }),
    });
    const result = await probeEnvironments({ registry, fetch, cache: new Map() });
    expect(result.kind === 'probed' && result.probes).toEqual([
      expect.objectContaining({ state: 'refused', status: 403, message: 'forbidden' }),
      expect.objectContaining({ state: 'error', status: 503, message: 'redis unavailable' }),
    ]);
  });

  it('reports an unusable registry as misconfigured, by variable name', async () => {
    vi.stubEnv('G2_ENVIRONMENTS', '');
    vi.stubEnv('G2_ADMIN_URL', 'not a url');
    vi.stubEnv('G2_ADMIN_SECRET', 's3cret-value');
    const result = await probeEnvironments({ cache: new Map() });
    expect(result.kind).toBe('misconfigured');
    expect(result.kind === 'misconfigured' && result.problems).toContain(
      'G2_ADMIN_URL is not a valid URL',
    );
    expect(JSON.stringify(result)).not.toContain('s3cret-value');
  });

  it('shares one probe per environment within the TTL, and re-probes after it', async () => {
    const { fetch, calls } = fakeFetch({ 'gw-dev': ok, 'gw-prod': ok });
    const cache = new Map();
    let clock = 1_000;
    const deps = { registry, fetch, cache, now: () => clock };

    await Promise.all([probeEnvironments(deps), probeEnvironments(deps)]);
    expect(calls).toHaveLength(2);

    clock += PROBE_TTL_MS - 1;
    await probeEnvironments(deps);
    expect(calls).toHaveLength(2);

    clock += 1;
    await probeEnvironments(deps);
    expect(calls).toHaveLength(4);
  });
});
