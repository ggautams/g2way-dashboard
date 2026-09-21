import { describe, expect, it, vi } from 'vitest';
import spec from '../../../contracts/openapi.json';
import type { Role } from '@/lib/auth/rbac';
import { migrateDatabase, openDatabase } from '@/lib/db';
import {
  completeAudit,
  getAuditEntry,
  listAudit,
  recordAudit,
  type AuditRecord,
} from '@/lib/db/audit';
import { hashKey, type AuditSink } from './audit-trail';
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

/** An in-memory audit sink: the rows as they stand after each write. */
function memoryAudit(): AuditSink & { rows: Map<string, AuditRecord> } {
  const rows = new Map<string, AuditRecord>();
  return {
    rows,
    async record(record) {
      const id = `row-${rows.size + 1}`;
      rows.set(id, record);
      return id;
    },
    async complete(id, record) {
      rows.set(id, record);
    },
  };
}

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/api/g2/${path}`, init);
}

function segmentsOf(path: string): string[] {
  return path.split('?')[0].split('/').map(decodeURIComponent);
}

async function proxy(
  path: string,
  init: RequestInit = {},
  reply?: () => Response,
  role: Role = 'owner',
) {
  const gateway = fakeGateway(reply);
  const audit = memoryAudit();
  const response = await proxyToGateway(request(path, init), segmentsOf(path), actorFor(role), {
    fetch: gateway.fetch,
    registry,
    audit,
  });
  return { response, calls: gateway.calls, audit: [...audit.rows.values()] };
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
    expect(calls[0].url).toBe('http://gw-dev:9696/g2/keys/a%2Fb?hashed=true&org_id=default');
  });

  it('scopes org-scoped operations to the configured org, whatever the browser sent', async () => {
    const orgRegistry = parseEnvironments({
      G2_ADMIN_URL: 'http://gw:9696',
      G2_ADMIN_SECRET: SECRET,
      G2_ORG_ID: 'acme',
    });
    const gateway = fakeGateway();
    await proxyToGateway(request('apis?org_id=other'), ['apis'], actorFor('owner'), {
      fetch: gateway.fetch,
      audit: memoryAudit(),
      registry: orgRegistry,
    });
    await proxyToGateway(request('reload', { method: 'POST' }), ['reload'], actorFor('owner'), {
      fetch: gateway.fetch,
      audit: memoryAudit(),
      registry: orgRegistry,
    });
    expect(gateway.calls.map((c) => c.url)).toEqual([
      'http://gw:9696/g2/apis?org_id=acme',
      'http://gw:9696/g2/reload',
    ]);
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
    const response = await proxyToGateway(request('apis/x'), ['apis', '..'], actorFor('owner'), {
      fetch: gateway.fetch,
      audit: memoryAudit(),
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

describe('role enforcement', () => {
  it('lets a viewer read and refuses its writes in the error envelope, without calling the gateway', async () => {
    const read = await proxy('apis', {}, undefined, 'viewer');
    expect(read.response.status).toBe(200);
    expect(read.calls).toHaveLength(1);

    const write = await proxy('apis', { method: 'POST', body: '{}' }, undefined, 'viewer');
    expect(write.response.status).toBe(403);
    expect(await write.response.json()).toEqual({
      error: 'forbidden: the viewer role lacks the apis:write permission (POST /g2/apis)',
    });
    expect(write.calls).toHaveLength(0);
  });

  it('lets an editor reload but not mint keys', async () => {
    expect((await proxy('reload', { method: 'POST' }, undefined, 'editor')).response.status).toBe(
      200,
    );
    const keys = await proxy('keys', { method: 'POST', body: '{}' }, undefined, 'editor');
    expect(keys.response.status).toBe(403);
    expect(keys.calls).toHaveLength(0);
  });

  it('refuses a portal-dev everything, reads included', async () => {
    for (const path of ['version', 'health', 'apis', 'keys']) {
      const { response, calls } = await proxy(path, {}, undefined, 'portal-dev');
      expect(response.status, path).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it('answers 404 and 405 before the role check', async () => {
    expect((await proxy('secrets', {}, undefined, 'portal-dev')).response.status).toBe(404);
    expect(
      (await proxy('reload', { method: 'DELETE' }, undefined, 'portal-dev')).response.status,
    ).toBe(405);
  });
});

/**
 * A small stateful gateway: `/g2/apis/{id}` and `/g2/keys/{key}` (GET, PUT,
 * DELETE), `POST /g2/keys` minting `RAW_KEY`, and `POST /g2/reload`. Enough to
 * see what the audit trail reads before and after a write.
 */
const RAW_KEY = 'raw-key-shown-once-7f3a9c';
const HMAC_SECRET = 'hmac-shared-secret-do-not-store';

function statefulGateway() {
  const apis = new Map<string, unknown>([
    ['httpbin', { api_id: 'httpbin', name: 'httpbin', listen_path: '/old/' }],
  ]);
  const keys = new Map<string, unknown>();
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const text = init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : '';
    const body = text === '' ? null : JSON.parse(text);
    const [, , collection, rawId] = url.pathname.split('/');
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    if (collection === 'reload') return Response.json({ reloaded: true });
    const store = collection === 'apis' ? apis : keys;
    const keyOf = (value: string) =>
      collection === 'keys' && url.searchParams.get('hashed') !== 'true' ? hashKey(value) : value;
    if (collection === 'keys' && id === undefined && method === 'POST') {
      const hash = hashKey(RAW_KEY);
      keys.set(hash, body);
      return Response.json({ key: RAW_KEY, key_hash: hash }, { status: 201 });
    }
    if (id === undefined) return Response.json({ error: 'unexpected' }, { status: 500 });
    if (method === 'GET') {
      const found = store.get(keyOf(id));
      return found === undefined
        ? Response.json({ error: `no such item ${id}` }, { status: 404 })
        : Response.json(found);
    }
    if (method === 'PUT') {
      if (typeof body !== 'object' || body === null || 'bad' in body) {
        return Response.json({ error: 'listen_path must start with /' }, { status: 400 });
      }
      const existed = store.has(keyOf(id));
      store.set(keyOf(id), body);
      return Response.json({ id, action: existed ? 'modified' : 'added' });
    }
    if (method === 'DELETE') {
      store.delete(keyOf(id));
      return Response.json({ id, action: 'deleted' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  return { apis, keys, calls, fetch: fetch as typeof globalThis.fetch };
}

async function sqliteAudit() {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  await migrateDatabase(database);
  const sink: AuditSink = {
    record: (record) => recordAudit(database, AUDIT_ORG, record),
    complete: (id, record) => completeAudit(database, AUDIT_ORG, id, record),
  };
  const rows = async () => {
    const { entries } = await listAudit(database, AUDIT_ORG);
    return Promise.all(entries.map(async (e) => (await getAuditEntry(database, AUDIT_ORG, e.id))!));
  };
  return { database, sink, rows };
}

// Stand-in org for the audit database; the real one comes from config.
const AUDIT_ORG = 'org-under-test';

async function write(
  gateway: ReturnType<typeof statefulGateway>,
  sink: AuditSink,
  path: string,
  init: RequestInit,
  role: Role = 'admin',
) {
  return proxyToGateway(request(path, init), segmentsOf(path), actorFor(role), {
    fetch: gateway.fetch,
    registry,
    audit: sink,
  });
}

describe('audited writes (ADR-0006)', () => {
  it('records an API update with before, after, request and the gateway call', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    const next = { api_id: 'httpbin', name: 'httpbin', listen_path: '/new/' };
    const response = await write(
      gateway,
      sink,
      'apis/httpbin',
      {
        method: 'PUT',
        body: JSON.stringify(next),
      },
      'editor',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'httpbin', action: 'modified' });
    // Before and after are read back with the same org scoping as any read.
    expect(gateway.calls).toEqual([
      'GET /g2/apis/httpbin?org_id=default',
      'PUT /g2/apis/httpbin',
      'GET /g2/apis/httpbin?org_id=default',
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({
      orgId: AUDIT_ORG,
      actorId: 'user-editor',
      actorEmail: 'editor@example.com',
      actorRole: 'editor',
      action: 'api.update',
      target: 'httpbin',
      before: { api_id: 'httpbin', name: 'httpbin', listen_path: '/old/' },
      after: next,
      request: next,
      gatewayMethod: 'PUT',
      gatewayPath: '/g2/apis/httpbin',
      gatewayStatus: 200,
      environment: 'dev',
      outcome: 'success',
      error: null,
    });
    await database.close();
  });

  it('records a delete with the before-state and no after', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    expect((await write(gateway, sink, 'apis/httpbin', { method: 'DELETE' })).status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ action: 'api.delete', outcome: 'success', after: null });
    expect(row.before).toMatchObject({ listen_path: '/old/' });
    await database.close();
  });

  it('records a gateway refusal with its message verbatim and no after', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    const response = await write(gateway, sink, 'apis/httpbin', {
      method: 'PUT',
      body: JSON.stringify({ bad: true }),
    });
    expect(response.status).toBe(400);
    const [row] = await rows();
    expect(row).toMatchObject({
      outcome: 'failure',
      gatewayStatus: 400,
      error: 'listen_path must start with /',
      after: null,
      request: { bad: true },
    });
    await database.close();
  });

  it('records an unreachable gateway as a failure with no status', async () => {
    const { database, sink, rows } = await sqliteAudit();
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    }) as typeof globalThis.fetch;
    const response = await proxyToGateway(
      request('reload', { method: 'POST' }),
      ['reload'],
      actorFor('editor'),
      { fetch, registry, audit: sink },
    );
    expect(response.status).toBe(502);
    const [row] = await rows();
    expect(row).toMatchObject({
      action: 'gateway.reload',
      outcome: 'failure',
      gatewayStatus: null,
      error: 'gateway unreachable (environment dev): fetch failed (connect ECONNREFUSED)',
    });
    await database.close();
  });

  it('records a reload with the gateway answer as the after-state', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    expect((await write(gateway, sink, 'reload', { method: 'POST' }, 'editor')).status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({
      action: 'gateway.reload',
      target: null,
      before: null,
      after: { reloaded: true },
      gatewayPath: '/g2/reload',
    });
    await database.close();
  });

  it('records a denied write, without calling the gateway', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    const response = await write(
      gateway,
      sink,
      'apis/httpbin',
      {
        method: 'PUT',
        body: '{}',
      },
      'viewer',
    );
    expect(response.status).toBe(403);
    expect(gateway.calls).toEqual([]);
    const [row] = await rows();
    expect(row).toMatchObject({
      actorRole: 'viewer',
      action: 'api.update',
      target: 'httpbin',
      outcome: 'denied',
      error: 'forbidden: the viewer role lacks the apis:write permission (PUT /g2/apis/{id})',
      gatewayMethod: null,
      gatewayStatus: null,
    });
    await database.close();
  });

  it('records a cross-site write as denied', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    const response = await write(gateway, sink, 'reload', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect((await rows())[0]).toMatchObject({
      outcome: 'denied',
      error: 'cross-site request refused',
    });
    await database.close();
  });

  it('does not audit reads', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    await write(gateway, sink, 'apis/httpbin', {});
    expect(await rows()).toEqual([]);
    await database.close();
  });

  it('fails closed: a write it cannot audit is refused and never sent', async () => {
    const gateway = statefulGateway();
    const broken: AuditSink = {
      record: async () => {
        throw new Error('disk I/O error');
      },
      complete: async () => {},
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await write(gateway, broken, 'apis/httpbin', {
      method: 'PUT',
      body: JSON.stringify({ api_id: 'httpbin' }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/^audit log unavailable/);
    expect(gateway.calls).toEqual(['GET /g2/apis/httpbin?org_id=default']);
    expect(gateway.apis.get('httpbin')).toMatchObject({ listen_path: '/old/' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('still answers when the row cannot be completed, and says so loudly', async () => {
    const gateway = statefulGateway();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink: AuditSink = {
      record: async () => 'row-1',
      complete: async () => {
        throw new Error('database is locked');
      },
    };
    const response = await write(gateway, sink, 'reload', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(String(logged.mock.calls[0][0])).toContain('row-1');
    logged.mockRestore();
  });
});

describe('audit redaction (ADR-0006 §4)', () => {
  it('never stores the raw key, the HMAC secret or the admin secret', async () => {
    const gateway = statefulGateway();
    const { database, sink, rows } = await sqliteAudit();
    const session = { alias: 'billing', hmac: { secret: HMAC_SECRET }, access: {} };
    const created = await write(gateway, sink, 'keys', {
      method: 'POST',
      body: JSON.stringify(session),
    });
    expect(created.status).toBe(201);
    // The creator still gets the raw key, once.
    expect(await created.json()).toEqual({ key: RAW_KEY, key_hash: hashKey(RAW_KEY) });

    // Then an update and a delete addressed by the raw key.
    await write(gateway, sink, `keys/${RAW_KEY}`, {
      method: 'PUT',
      body: JSON.stringify({ ...session, hmac: { secret: `${HMAC_SECRET}-rotated` } }),
    });
    await write(gateway, sink, `keys/${RAW_KEY}`, { method: 'DELETE' });

    // Rows in the same millisecond have no defined order; look them up by action.
    const stored = await rows();
    expect(stored.map((row) => row.action).sort()).toEqual([
      'key.create',
      'key.delete',
      'key.update',
    ]);
    const byAction = (action: string) => stored.find((row) => row.action === action)!;
    const everything = JSON.stringify(stored);
    for (const secret of [RAW_KEY, HMAC_SECRET, SECRET, STAGING_SECRET]) {
      expect(everything).not.toContain(secret);
    }
    for (const row of stored) expect(row.target).toBe(hashKey(RAW_KEY));

    const create = byAction('key.create');
    const update = byAction('key.update');
    expect(create.after).toMatchObject({ alias: 'billing', hmac: { secret: '[redacted]' } });
    expect(update.gatewayPath).toBe(`/g2/keys/${hashKey(RAW_KEY)}`);
    expect(update.note).toContain('SHA-256 hash');
    // A rotated secret shows as changed, never as its value.
    expect(update.before).toMatchObject({ hmac: { secret: '[redacted]' } });
    expect(update.after).toMatchObject({ hmac: { secret: '[redacted: changed]' } });
    await database.close();
  });

  it('strips the raw key from the create answer when the key cannot be read back', async () => {
    const { database, sink, rows } = await sqliteAudit();
    const fetch = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === '/g2/keys'
        ? Response.json({ key: RAW_KEY, key_hash: 'h1' }, { status: 201 })
        : Response.json(
            { error: 'storage unavailable' },
            { status: 503 },
          )) as typeof globalThis.fetch;
    await proxyToGateway(
      request('keys', { method: 'POST', body: '{}' }),
      ['keys'],
      actorFor('admin'),
      { fetch, registry, audit: sink },
    );
    const [row] = await rows();
    expect(JSON.stringify(row)).not.toContain(RAW_KEY);
    expect(row).toMatchObject({ target: 'h1', outcome: 'success' });
    expect(row.note).toContain('after-state unavailable: GET answered 503 storage unavailable');
    await database.close();
  });
});
