import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { parseEnvironments } from './environments';
import { ENVIRONMENT_HEADER, compileEndpoints, proxyToGateway } from './proxy';

const SECRET = 'test-secret-do-not-leak';
const STAGING_SECRET = 'staging-secret-do-not-leak';
const ORIGIN = 'http://dashboard.test';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,staging',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: SECRET,
  G2_ENV_STAGING_URL: 'https://gw-staging/admin',
  G2_ENV_STAGING_SECRET: STAGING_SECRET,
});

type Call = { url: string; init: RequestInit };

/** A fake gateway: records each call and answers with `reply`. */
function fakeGateway(reply: () => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return reply();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/api/g2/${path}`, init);
}

function segmentsOf(path: string): string[] {
  return path.split('?')[0].split('/').map(decodeURIComponent);
}

async function proxy(path: string, init: RequestInit = {}, reply?: () => Response) {
  const gateway = fakeGateway(reply);
  const response = await proxyToGateway(request(path, init), segmentsOf(path), {
    fetch: gateway.fetch,
    registry,
  });
  return { response, calls: gateway.calls };
}

async function assertNoSecret(response: Response) {
  const text = await response.clone().text();
  const headers = JSON.stringify([...response.headers]);
  for (const secret of [SECRET, STAGING_SECRET]) {
    expect(text).not.toContain(secret);
    expect(headers).not.toContain(secret);
  }
}

describe('forwarding', () => {
  it('attaches the admin secret and forwards method, query and body', async () => {
    const body = JSON.stringify({ api_id: 'a', name: 'A' });
    const { response, calls } = await proxy('apis?verbose=1', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('http://gw-dev:9696/g2/apis?verbose=1');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('x-g2-authorization')).toBe(SECRET);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
    await assertNoSecret(response);
  });

  it('never forwards the browser cookies or Authorization header', async () => {
    const { calls } = await proxy('apis', {
      headers: { cookie: 'session=abc', authorization: 'Bearer user-token' },
    });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
  });

  it('sends no body on GET', async () => {
    const { calls } = await proxy('node');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('keeps an encoded slash inside one path segment', async () => {
    const { response, calls } = await proxy('keys/a%2Fb?hashed=true');
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('http://gw-dev:9696/g2/keys/a%2Fb?hashed=true');
  });

  it('selects the environment from the header and echoes it back', async () => {
    const { response, calls } = await proxy('version', {
      headers: { [ENVIRONMENT_HEADER]: 'staging' },
    });
    expect(calls[0].url).toBe('https://gw-staging/admin/g2/version');
    expect(new Headers(calls[0].init.headers).get('x-g2-authorization')).toBe(STAGING_SECRET);
    expect(response.headers.get(ENVIRONMENT_HEADER)).toBe('staging');
  });
});

describe('the gateway response passes through untouched', () => {
  for (const [status, error] of [
    [403, 'forbidden'],
    [404, 'api not found'],
    [409, 'api already exists'],
    [503, 'storage unavailable'],
  ] as const) {
    it(`${status} {"error": "${error}"}`, async () => {
      const raw = `{"error":"${error}"}`;
      const { response } = await proxy(
        'apis',
        {},
        () => new Response(raw, { status, headers: { 'content-type': 'application/json' } }),
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(raw);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  }
});

describe('the allowlist', () => {
  it('refuses a path the gateway does not document, without calling it', async () => {
    const { response, calls } = await proxy('secrets');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not a g2way admin endpoint: /g2/secrets' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a method the endpoint does not support, naming the ones it does', async () => {
    const { response, calls } = await proxy('reload', { method: 'DELETE' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(calls).toHaveLength(0);
  });

  it('refuses dot segments', async () => {
    const gateway = fakeGateway();
    const response = await proxyToGateway(request('apis/x'), ['apis', '..'], {
      fetch: gateway.fetch,
      registry,
    });
    expect(response.status).toBe(400);
    expect(gateway.calls).toHaveLength(0);
  });

  it('reaches every /g2/ endpoint and method in the spec', async () => {
    const paths: Record<string, Record<string, unknown>> = spec.paths;
    const endpoints = compileEndpoints(paths);
    expect(endpoints.length).toBeGreaterThan(10);
    for (const [template, operations] of Object.entries(paths)) {
      if (!template.startsWith('/g2/')) continue;
      const path = template.slice('/g2/'.length).replace(/\{[^}]+\}/g, 'x');
      for (const method of Object.keys(operations)) {
        const { response } = await proxy(path, {
          method: method.toUpperCase(),
          body: method === 'get' ? undefined : '{}',
        });
        expect(response.status, `${method} ${template}`).toBe(200);
      }
    }
  });

  it('does not expose /metrics', async () => {
    const { response } = await proxy('metrics');
    expect(response.status).toBe(404);
  });
});

describe('cross-site writes', () => {
  it('refuses a POST from another origin', async () => {
    const { response, calls } = await proxy('reload', {
      method: 'POST',
      headers: { origin: 'http://evil.test' },
    });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a DELETE flagged cross-site by the browser', async () => {
    const { response } = await proxy('apis/a', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
  });

  it('allows a same-origin POST', async () => {
    const { response } = await proxy('reload', {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(200);
  });

  it('allows a cross-site GET (reads carry no side effects)', async () => {
    const { response } = await proxy('version', { headers: { origin: 'http://evil.test' } });
    expect(response.status).toBe(200);
  });
});

describe('failures', () => {
  it('reports an unreachable gateway as 502 with the underlying cause', async () => {
    const { response } = await proxy('node', {}, () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    expect(response.status).toBe(502);
    expect(await response.clone().json()).toEqual({
      error: 'gateway unreachable (environment dev): fetch failed (connect ECONNREFUSED)',
    });
    expect(response.headers.get(ENVIRONMENT_HEADER)).toBe('dev');
    await assertNoSecret(response);
  });

  it('rejects an unknown environment with 400', async () => {
    const { response, calls } = await proxy('node', { headers: { [ENVIRONMENT_HEADER]: 'prod' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown gateway environment: prod' });
    expect(calls).toHaveLength(0);
  });
});
