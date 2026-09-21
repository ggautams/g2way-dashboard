import { describe, expect, it } from 'vitest';
import type { components } from '../../../contracts/g2way.d.ts';
import { unwrap } from './client';
import { UnknownEnvironmentError, parseEnvironments } from './environments';
import { GatewayUnreachableError } from './errors';
import { OrgScopeError } from './org-scope';
import { gatewayClient } from './server-client';

const SECRET = 'test-secret-do-not-leak';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,staging',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: SECRET,
  G2_ENV_STAGING_URL: 'https://gw-staging/admin',
  G2_ENV_STAGING_SECRET: 'staging-secret',
  G2_ORG_ID: 'acme',
});

/** A fake gateway: records each request and answers with `reply`. */
function fakeGateway(reply: () => Response = () => Response.json({ id: 'a', action: 'added' })) {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return reply();
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

describe('gatewayClient', () => {
  it('calls the environment directly with its admin secret', async () => {
    const gateway = fakeGateway(() => Response.json({ version: '1.2.3' }));
    const client = gatewayClient('staging', { registry, fetch: gateway.fetch });
    await unwrap(client.GET('/g2/version'));
    const [request] = gateway.requests;
    expect(request.url).toBe('https://gw-staging/admin/g2/version');
    expect(request.headers.get('x-g2-authorization')).toBe('staging-secret');
  });

  it('uses the default environment when none is named', async () => {
    const gateway = fakeGateway();
    await gatewayClient(undefined, { registry, fetch: gateway.fetch }).GET('/g2/node');
    expect(gateway.requests[0].url).toBe('http://gw-dev:9696/g2/node');
    expect(gateway.requests[0].headers.get('x-g2-authorization')).toBe(SECRET);
  });

  it('adds the configured org_id only where the spec declares it', async () => {
    const gateway = fakeGateway();
    const client = gatewayClient(undefined, { registry, fetch: gateway.fetch });
    await client.GET('/g2/apis');
    await client.POST('/g2/reload');
    await client.PUT('/g2/keys/{key}', {
      params: { path: { key: 'k' }, query: { hashed: true } },
      body: {} as components['schemas']['KeySession'],
    });
    expect(gateway.requests.map((r) => r.url)).toEqual([
      'http://gw-dev:9696/g2/apis?org_id=acme',
      'http://gw-dev:9696/g2/reload',
      'http://gw-dev:9696/g2/keys/k?hashed=true&org_id=acme',
    ]);
    // Re-targeting the request must keep its method, and its body gains the org.
    expect(gateway.requests[2].method).toBe('PUT');
    expect(await gateway.requests[2].text()).toBe('{"org_id":"acme"}');
  });

  it('scopes API, policy and key write bodies to the configured org', async () => {
    const api: components['schemas']['ApiDefinition'] = {
      api_id: 'a',
      name: 'A',
      listen_path: '/a/',
      target_url: 'http://a',
      org_id: 'acme',
    };
    const gateway = fakeGateway();
    const client = gatewayClient(undefined, { registry, fetch: gateway.fetch });
    await client.POST('/g2/policies', {
      body: { policy_id: 'gold', name: 'Gold' } as components['schemas']['Policy'],
    });
    await client.PUT('/g2/apis/{id}', {
      params: { path: { id: 'a' } },
      body: api,
    });
    expect(await gateway.requests[0].json()).toEqual({
      org_id: 'acme',
      policy_id: 'gold',
      name: 'Gold',
    });
    expect(gateway.requests[0].headers.get('content-type')).toMatch(/json/);
    expect(await gateway.requests[1].text()).toBe(JSON.stringify(api));
  });

  it('refuses to send a body naming another org', async () => {
    const gateway = fakeGateway();
    const client = gatewayClient(undefined, { registry, fetch: gateway.fetch });
    const error = await client
      .POST('/g2/keys', { body: { org_id: 'other' } as components['schemas']['KeySession'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgScopeError);
    expect((error as OrgScopeError).reason).toBe('cross-org');
    expect(gateway.requests).toEqual([]);
  });

  it('reports a network failure as unreachable, naming the environment and cause', async () => {
    const client = gatewayClient('dev', {
      registry,
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      },
    });
    const error = await client.GET('/g2/node').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    expect((error as Error).message).toBe(
      'gateway unreachable (environment dev): fetch failed (connect ECONNREFUSED)',
    );
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('rejects an unknown environment', () => {
    expect(() => gatewayClient('prod', { registry })).toThrow(UnknownEnvironmentError);
  });
});
