import { describe, expect, it } from 'vitest';
import type { ConsoleAnswer } from '@/lib/apis/console';
import { CONSOLE_MAX_RESPONSE_BYTES } from '@/lib/apis/console';
import type { ApiDefinition } from '@/lib/apis/list';
import type { Role } from '@/lib/auth/rbac';
import type { AuditRecord } from '@/lib/db/audit';
import type { AuditSink } from './audit-trail';
import { CONSOLE_ACTION, sendConsoleRequest, type ConsoleDeps } from './console';
import { parseEnvironments } from './environments';

// Stand-in org, secrets and addresses: the real ones always come from config.
const ORG = 'org-under-test';
const ADMIN_SECRET = 'console-admin-secret-do-not-leak';
const ORIGIN = 'http://dashboard.test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev,bare',
  G2_ENV_DEV_URL: 'http://gw-admin:9696',
  G2_ENV_DEV_SECRET: ADMIN_SECRET,
  G2_ENV_DEV_PROXY_URL: 'http://gw-proxy.internal:8080',
  G2_ENV_BARE_URL: 'http://gw-bare:9696',
  G2_ENV_BARE_SECRET: `${ADMIN_SECRET}-bare`,
});

const API: ApiDefinition = {
  api_id: 'users',
  name: 'Users',
  listen_path: '/users/',
  target_url: 'http://upstream:9000',
  block_paths: [{ pattern: '^/users/admin' }],
  versioning: { default_version: 'v1', versions: { v1: {}, v2: {} } },
};

type Sent = { url: string; method: string; headers: Headers; body: string | null };

/**
 * A fake gateway: the admin listener serves `GET /g2/apis/users`, the proxy
 * listener answers with `reply`. Records every call on each listener.
 */
function fakeGateway(
  reply: (sent: Sent) => Response | Promise<Response> = () => Response.json({ ok: true }),
) {
  const admin: string[] = [];
  const proxied: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host === 'gw-admin:9696') {
      admin.push(`${request.method} ${url.pathname}${url.search}`);
      expect(request.headers.get('x-g2-authorization')).toBe(ADMIN_SECRET);
      return url.pathname === '/g2/apis/users'
        ? Response.json(API)
        : Response.json({ error: 'api not found' }, { status: 404 });
    }
    expect(url.host).toBe('gw-proxy.internal:8080');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body =
      init?.body === undefined ? null : new TextDecoder().decode(init.body as Uint8Array);
    const sent = { url: request.url, method: request.method, headers: request.headers, body };
    proxied.push(sent);
    return reply(sent);
  }) as typeof globalThis.fetch;
  return { admin, proxied, fetch };
}

function memoryAudit(options: { failRecord?: boolean } = {}): AuditSink & { rows: AuditRecord[] } {
  const rows: AuditRecord[] = [];
  return {
    rows,
    async record(record) {
      if (options.failRecord) throw new Error('database is locked');
      rows.push(structuredClone(record));
      return String(rows.length - 1);
    },
    async complete(id, record) {
      rows[Number(id)] = structuredClone(record);
    },
  };
}

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

async function send(
  body: unknown,
  options: {
    role?: Role;
    headers?: Record<string, string>;
    reply?: (sent: Sent) => Response | Promise<Response>;
    deps?: Partial<ConsoleDeps>;
  } = {},
) {
  const gateway = fakeGateway(options.reply);
  const audit = memoryAudit();
  let tick = 0;
  const response = await sendConsoleRequest(
    new Request(`${ORIGIN}/api/g2/console`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-g2-environment': 'dev',
        ...options.headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    actorFor(options.role ?? 'editor'),
    {
      fetch: gateway.fetch,
      registry,
      audit,
      clock: () => (tick += 5),
      nowSecs: () => 0,
      ...options.deps,
    },
  );
  const json: unknown = await response.json();
  return { response, json, gateway, rows: audit.rows };
}

const REQUEST = {
  apiId: 'users',
  method: 'GET',
  path: '42?token=query-secret',
  headers: [['Authorization', 'Bearer user-credential-secret']],
  body: '',
  version: null,
};

describe('the request console BFF (ADR-0011)', () => {
  it('sends to the proxy listener under the stored listen path, without the admin secret', async () => {
    const { response, json, gateway } = await send(REQUEST);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(gateway.admin).toEqual([`GET /g2/apis/users?org_id=${ORG}`]);
    expect(gateway.proxied).toHaveLength(1);
    const [sent] = gateway.proxied;
    expect(sent?.url).toBe('http://gw-proxy.internal:8080/users/42?token=query-secret');
    expect(sent?.headers.get('authorization')).toBe('Bearer user-credential-secret');
    expect(sent?.headers.get('x-g2-authorization')).toBeNull();
    // The browser's own cookies never ride along.
    expect(sent?.headers.get('cookie')).toBeNull();

    const answer = json as ConsoleAnswer;
    expect(answer.sent).toEqual({
      method: 'GET',
      path: '/users/42',
      query: 'token=query-secret',
      headerNames: ['Authorization'],
    });
    expect(answer.response.status).toBe(200);
    expect(answer.response.body).toBe('{"ok":true}');
    expect(answer.timing).toEqual({ headersMs: 5, totalMs: 10 });
    expect(answer.trace.origin).toBe('upstream');
    expect(answer.trace.version).toEqual({ name: 'v1', source: 'the default version' });
  });

  it('never gives the browser the proxy URL', async () => {
    const { json } = await send(REQUEST);
    expect(JSON.stringify(json)).not.toContain('gw-proxy.internal');
    const refused = await send(REQUEST, {
      reply: () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED gw-proxy.internal:8080'), {
            code: 'ECONNREFUSED',
          }),
        });
      },
    });
    expect(refused.response.status).toBe(502);
    expect(refused.json).toEqual({
      error: "the gateway's proxy listener did not answer (environment dev): ECONNREFUSED",
    });
  });

  it('audits method, path, version and status only: no query, header values or body', async () => {
    const { rows } = await send({ ...REQUEST, method: 'POST', body: '{"password":"body-secret"}' });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      action: CONSOLE_ACTION,
      target: 'users',
      environment: 'dev',
      outcome: 'success',
      request: { method: 'POST', path: '/users/42', version: null },
      gateway: { method: 'POST', path: '/users/42', status: 200 },
    });
    const text = JSON.stringify(rows);
    for (const secret of [
      'query-secret',
      'user-credential-secret',
      'body-secret',
      'Authorization',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses a role without apis:test, and records the denial', async () => {
    const { response, json, gateway, rows } = await send(REQUEST, { role: 'viewer' });
    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: 'forbidden: the viewer role lacks the apis:test permission (request console)',
    });
    expect(gateway.admin).toEqual([]);
    expect(gateway.proxied).toEqual([]);
    expect(rows).toMatchObject([{ action: CONSOLE_ACTION, outcome: 'denied' }]);
  });

  it('refuses a cross-site call', async () => {
    const { response, gateway } = await send(REQUEST, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
    expect(gateway.proxied).toEqual([]);
  });

  it('says the console is not configured when the environment has no proxy URL', async () => {
    const { response, json, gateway } = await send(REQUEST, {
      headers: { 'x-g2-environment': 'bare' },
    });
    expect(response.status).toBe(409);
    expect((json as { error: string }).error).toContain('G2_PROXY_URL');
    expect(gateway.proxied).toEqual([]);
  });

  it("passes the gateway's own error verbatim when the definition cannot be read", async () => {
    const { response, json } = await send({ ...REQUEST, apiId: 'nope' });
    expect(response.status).toBe(404);
    expect(json).toEqual({ error: 'api not found' });
  });

  it('refuses a path that leaves the listen path, before anything is sent or audited', async () => {
    for (const path of ['../g2/apis', '%2e%2e/admin', '%2F%2Fevil']) {
      const { response, gateway, rows } = await send({ ...REQUEST, path });
      expect(response.status, path).toBe(400);
      expect(gateway.proxied).toEqual([]);
      expect(rows).toEqual([]);
    }
  });

  it('refuses a body on GET, and malformed requests', async () => {
    expect((await send({ ...REQUEST, body: 'x' })).response.status).toBe(400);
    expect((await send('not json')).response.status).toBe(400);
    expect((await send({ ...REQUEST, headers: [['Host', 'evil']] })).response.status).toBe(400);
  });

  it('puts the chosen version where the selector reads it, replacing a typed one', async () => {
    const { gateway, json } = await send({
      ...REQUEST,
      headers: [['x-api-version', 'v1']],
      version: 'v2',
    });
    expect(gateway.proxied[0]?.headers.get('x-api-version')).toBe('v2');
    expect((json as ConsoleAnswer).trace.version?.name).toBe('v2');
  });

  it('fails closed when the audit row cannot be written', async () => {
    const gateway = fakeGateway();
    const response = await sendConsoleRequest(
      new Request(`${ORIGIN}/api/g2/console`, {
        method: 'POST',
        headers: { 'x-g2-environment': 'dev' },
        body: JSON.stringify(REQUEST),
      }),
      actorFor('editor'),
      { fetch: gateway.fetch, registry, audit: memoryAudit({ failRecord: true }) },
    );
    expect(response.status).toBe(503);
    expect(gateway.proxied).toEqual([]);
  });

  it("caps the body it reads, and surfaces g2way's error envelope verbatim", async () => {
    const big = await send(REQUEST, {
      reply: () => new Response('x'.repeat(CONSOLE_MAX_RESPONSE_BYTES * 3), { status: 200 }),
    });
    const answer = big.json as ConsoleAnswer;
    expect(answer.response.truncated).toBe(true);
    expect(answer.response.body).toHaveLength(CONSOLE_MAX_RESPONSE_BYTES);

    const blocked = await send(
      { ...REQUEST, path: 'admin/x' },
      { reply: () => Response.json({ error: 'path blocked' }, { status: 403 }) },
    );
    const trace = (blocked.json as ConsoleAnswer).trace;
    expect((blocked.json as ConsoleAnswer).response.gatewayError).toBe('path blocked');
    expect(trace.steps.find((s) => s.id === 'path-policy')?.verdict).toBe('rejected');
    expect(trace.steps.find((s) => s.id === 'path-policy')?.version).toBe('v1');
  });

  it('does not follow redirects, and does not show a binary body', async () => {
    const redirect = await send(REQUEST, {
      reply: () => new Response(null, { status: 302, headers: { location: 'http://elsewhere/' } }),
    });
    expect((redirect.json as ConsoleAnswer).response.status).toBe(302);
    expect(redirect.gateway.proxied).toHaveLength(1);
    const binary = await send(REQUEST, {
      reply: () =>
        new Response(new Uint8Array([0, 1, 2]), { headers: { 'content-type': 'image/png' } }),
    });
    expect((binary.json as ConsoleAnswer).response).toMatchObject({
      binary: true,
      body: '',
      bytes: 3,
    });
  });
});
