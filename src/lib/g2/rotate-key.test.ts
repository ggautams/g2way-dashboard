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
import {
  deleteKeyMetadata,
  getKeyMetadata,
  rekeyKeyMetadata,
  upsertKeyMetadata,
} from '@/lib/db/key-metadata';
import { hashKey, type AuditSink } from './audit-trail';
import { parseEnvironments } from './environments';
import { ROTATE_ACTION, rotateKey } from './rotate-key';
import { ENVIRONMENT_COOKIE } from './selected-environment';

// Stand-in org and secrets: the real ones always come from config.
const ORG = 'org-under-test';
const SECRET = 'rotate-test-secret-do-not-leak';
const ORIGIN = 'http://dashboard.test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev,staging',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: SECRET,
  G2_ENV_STAGING_URL: 'http://gw-staging:9696',
  G2_ENV_STAGING_SECRET: `${SECRET}-staging`,
});

const OLD_RAW = 'old-raw-key-never-seen-by-the-dashboard';
const OLD = hashKey(OLD_RAW);
const NEW_RAW = 'new-raw-key-shown-once-9d2e1b';
const NEW = hashKey(NEW_RAW);
const HMAC_SECRET = 'hmac-secret-carried-over-not-stored';
const SESSION = {
  org_id: ORG,
  alias: 'billing',
  active: true,
  rate: { requests: 10, per_seconds: 60 },
  hmac: { secret: HMAC_SECRET },
};

type Fail = Partial<Record<'GET' | 'POST' | 'DELETE', () => Response>>;

/**
 * A fake gateway holding one key (`OLD`): `GET`/`DELETE /g2/keys/{hash}`,
 * `POST /g2/keys` minting `NEW_RAW`. `fail` overrides one method's answer.
 */
function fakeGateway(fail: Fail = {}) {
  const keys = new Map<string, unknown>([[OLD, SESSION]]);
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET') as 'GET' | 'POST' | 'DELETE';
    calls.push(`${method} ${url.pathname}${url.search}`);
    expect(new Headers(init.headers).get('x-g2-authorization')).toBe(SECRET);
    const override = fail[method];
    if (override) return override();
    const [, , , id] = url.pathname.split('/');
    if (method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer));
      bodies.push(body);
      keys.set(NEW, body);
      return Response.json({ key: NEW_RAW, key_hash: NEW }, { status: 201 });
    }
    const hash = decodeURIComponent(id);
    if (!keys.has(hash)) return Response.json({ error: 'key not found' }, { status: 404 });
    if (method === 'GET') return Response.json(keys.get(hash));
    keys.delete(hash);
    return Response.json({ id: hash, action: 'deleted' });
  }) as typeof globalThis.fetch;
  return { keys, calls, bodies, fetch };
}

/** An in-memory audit sink: the rows as they stand after each write. */
function memoryAudit(): AuditSink & { rows: Map<string, AuditRecord> } {
  const rows = new Map<string, AuditRecord>();
  return {
    rows,
    async record(record) {
      const id = `row-${rows.size + 1}`;
      rows.set(id, structuredClone(record));
      return id;
    },
    async complete(id, record) {
      rows.set(id, structuredClone(record));
    },
  };
}

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

function rotateRequest(headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/g2/keys/${OLD}/rotate`, { method: 'POST', headers });
}

async function rotate(fail: Fail = {}, role: Role = 'admin', headers?: Record<string, string>) {
  const gateway = fakeGateway(fail);
  const audit = memoryAudit();
  const response = await rotateKey(rotateRequest(headers), OLD, actorFor(role), {
    fetch: gateway.fetch,
    registry,
    audit,
  });
  const rows = [...audit.rows.values()];
  return {
    response,
    body: await response.json(),
    gateway,
    rows,
    rotateRow: rows.find((row) => row.action === ROTATE_ACTION),
  };
}

describe('key rotation (ADR-0009)', () => {
  it('reads the session, creates a key with it, deletes the old one, and says so once', async () => {
    const { response, body, gateway, rows, rotateRow } = await rotate();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-g2-environment')).toBe('dev');
    expect(body).toEqual({ outcome: 'rotated', key: NEW_RAW, key_hash: NEW, old_hash: OLD });

    // Every call by hash, scoped to the configured org, in order.
    expect(gateway.calls).toEqual([
      `GET /g2/keys/${OLD}?hashed=true&org_id=${ORG}`,
      'POST /g2/keys',
      // The proxy's after-read of the created key.
      `GET /g2/keys/${NEW}?hashed=true&org_id=${ORG}`,
      `GET /g2/keys/${OLD}?hashed=true&org_id=${ORG}`,
      `DELETE /g2/keys/${OLD}?hashed=true&org_id=${ORG}`,
    ]);
    expect(gateway.bodies).toEqual([SESSION]);
    expect([...gateway.keys.keys()]).toEqual([NEW]);

    // One row links old and new; each gateway write is audited on its own too.
    expect(rows.map((row) => row.action).sort()).toEqual([
      'key.create',
      'key.delete',
      'key.rotate',
    ]);
    expect(rotateRow).toMatchObject({
      actor: { email: 'admin@example.com' },
      target: OLD,
      environment: 'dev',
      outcome: 'success',
      before: { key_hash: OLD, session: SESSION },
      after: { key_hash: NEW, session: SESSION },
      gateway: { method: 'DELETE', path: `/g2/keys/${OLD}`, status: 200 },
    });
    expect(rotateRow?.notes).toContain(`new key ${NEW}`);
  });

  it('stops at a failed create, leaves the old key alone and quotes the gateway', async () => {
    const error = 'invalid key session: `rate.requests` must be greater than zero';
    const { response, body, gateway, rotateRow } = await rotate({
      POST: () => Response.json({ error }, { status: 400 }),
    });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error });
    expect(gateway.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    expect(gateway.keys.has(OLD)).toBe(true);
    expect(rotateRow).toMatchObject({
      outcome: 'failure',
      error: `creating the new key failed: ${error}`,
      gateway: { method: 'POST', path: '/g2/keys', status: 400 },
    });
    expect(rotateRow?.notes).toContain('the old key is unchanged');
  });

  it('stops before creating anything when the old key cannot be read', async () => {
    const gateway = fakeGateway();
    gateway.keys.clear();
    const audit = memoryAudit();
    const response = await rotateKey(rotateRequest(), OLD, actorFor('owner'), {
      fetch: gateway.fetch,
      registry,
      audit,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'key not found' });
    expect(gateway.calls).toHaveLength(1);
    expect([...audit.rows.values()][0]).toMatchObject({
      action: ROTATE_ACTION,
      outcome: 'failure',
    });
  });

  it('reports a failed delete after a successful create: both keys exist, the new hash named', async () => {
    const error = 'storage unavailable';
    const { response, body, gateway, rotateRow } = await rotate({
      DELETE: () => Response.json({ error }, { status: 503 }),
    });
    // The new key exists, so its raw value must still reach the user, once.
    expect(response.status).toBe(201);
    expect(body).toEqual({
      outcome: 'partial',
      key: NEW_RAW,
      key_hash: NEW,
      old_hash: OLD,
      error,
    });
    expect([...gateway.keys.keys()].sort()).toEqual([NEW, OLD].sort());
    expect(rotateRow).toMatchObject({
      outcome: 'failure',
      after: { key_hash: NEW },
      gateway: { method: 'DELETE', path: `/g2/keys/${OLD}`, status: 503 },
    });
    expect(rotateRow?.error).toBe(
      `both keys now exist: created ${NEW}, but deleting ${OLD} failed: ${error}`,
    );
  });

  it('refuses a role without keys:write, recording the refusal and calling nothing', async () => {
    const { response, body, gateway, rows } = await rotate({}, 'editor');
    expect(response.status).toBe(403);
    expect(body.error).toMatch(/editor role lacks the keys:write permission/);
    expect(gateway.calls).toEqual([]);
    expect(rows).toMatchObject([{ action: ROTATE_ACTION, outcome: 'denied', target: OLD }]);
  });

  it('refuses a cross-site request', async () => {
    const { response, gateway } = await rotate({}, 'admin', {
      origin: 'https://evil.test',
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
    expect(gateway.calls).toEqual([]);
  });

  it('pins every call to the environment the request named', async () => {
    const gateway = fakeGateway();
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      // Answer as if staging's secret were dev's, to reuse the fake.
      return gateway.fetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          'x-g2-authorization': SECRET,
        },
      });
    }) as typeof globalThis.fetch;
    const response = await rotateKey(
      rotateRequest({ 'x-g2-environment': 'staging', cookie: `${ENVIRONMENT_COOKIE}=dev` }),
      OLD,
      actorFor('admin'),
      { fetch, registry, audit: memoryAudit() },
    );
    expect(response.status).toBe(201);
    expect(calls.every((url) => url.startsWith('http://gw-staging:9696/'))).toBe(true);
  });

  it('starts nothing when the audit row cannot be written (fail closed)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gateway = fakeGateway();
    const response = await rotateKey(rotateRequest(), OLD, actorFor('admin'), {
      fetch: gateway.fetch,
      registry,
      audit: {
        record: async () => {
          throw new Error('disk full');
        },
        complete: async () => {},
      },
    });
    expect(response.status).toBe(503);
    expect(gateway.calls).toEqual([]);
    logged.mockRestore();
  });

  it('refuses something that is not a hash', async () => {
    const response = await rotateKey(rotateRequest(), 'a/b', actorFor('admin'), {
      registry,
      audit: memoryAudit(),
    });
    expect(response.status).toBe(400);
  });
});

describe('the raw key is never persisted', () => {
  async function sqliteRows(fail: Fail = {}) {
    const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
    await migrateDatabase(database);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gateway = fakeGateway(fail);
    const response = await rotateKey(rotateRequest(), OLD, actorFor('admin'), {
      fetch: gateway.fetch,
      registry,
      audit: {
        record: (record) => recordAudit(database, ORG, record),
        complete: (id, record) => completeAudit(database, ORG, id, record),
      },
    });
    const { entries } = await listAudit(database, ORG);
    const rows = await Promise.all(entries.map((e) => getAuditEntry(database, ORG, e.id)));
    const printed = JSON.stringify([...logged.mock.calls, ...logs.mock.calls]);
    logged.mockRestore();
    logs.mockRestore();
    await database.close();
    return { response, rows, printed };
  }

  it.each([
    ['a rotation', {}],
    [
      'a rotation whose delete fails',
      { DELETE: () => Response.json({ error: 'x' }, { status: 503 }) },
    ],
  ] as const)('%s stores and logs no raw key and no secret', async (_, fail) => {
    const { response, rows, printed } = await sqliteRows(fail);
    // The caller gets the raw key, once...
    expect((await response.json()).key).toBe(NEW_RAW);
    // ...and nothing else ever holds it.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const stored = JSON.stringify(rows);
    for (const secret of [NEW_RAW, OLD_RAW, HMAC_SECRET, SECRET]) {
      expect(stored).not.toContain(secret);
      expect(printed).not.toContain(secret);
    }
    expect(stored).toContain(NEW);
  });
});

describe('key metadata follows a rotation (ADR-0009 §7)', () => {
  async function withInventory(fail: Fail = {}) {
    const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
    await migrateDatabase(database);
    const actor = actorFor('admin');
    const fields = { label: 'Billing', owner: 'finance', notes: null };
    await upsertKeyMetadata(database, ORG, { environment: 'dev', keyHash: OLD, fields, actor });
    const order: string[] = [];
    const gateway = fakeGateway(fail);
    const response = await rotateKey(rotateRequest(), OLD, actor, {
      fetch: gateway.fetch,
      registry,
      audit: {
        record: (record) => recordAudit(database, ORG, record),
        complete: (id, record) => completeAudit(database, ORG, id, record),
        carryKey: async (change) => {
          order.push(`carry ${change.from === OLD} ${change.to === NEW}`);
          return (await rekeyKeyMetadata(database, ORG, { ...change, keepSource: true })) !== null;
        },
        forgetKey: async (key) => {
          order.push(`forget ${key.keyHash === OLD}`);
          await deleteKeyMetadata(database, ORG, key);
        },
      },
    });
    const meta = async (keyHash: string) =>
      (await getKeyMetadata(database, ORG, { environment: 'dev', keyHash }))?.label;
    const result = {
      status: response.status,
      order,
      old: await meta(OLD),
      new: await meta(NEW),
      actions: (await listAudit(database, ORG)).entries.map((e) => e.action),
    };
    await database.close();
    return result;
  }

  it('is carried before the old key is deleted, so a completed rotation moves it', async () => {
    const result = await withInventory();
    expect(result.status).toBe(201);
    expect(result.order).toEqual(['carry true true', 'forget true']);
    expect(result.new).toBe('Billing');
    expect(result.old).toBeUndefined();
    expect(result.actions).toEqual(
      expect.arrayContaining(['key.metadata.rekey', 'key.metadata.delete']),
    );
  });

  it('describes both keys when the old one could not be deleted', async () => {
    const result = await withInventory({
      DELETE: () => Response.json({ error: 'storage down' }, { status: 503 }),
    });
    expect(result.status).toBe(201);
    expect(result.order).toEqual(['carry true true']);
    expect([result.old, result.new]).toEqual(['Billing', 'Billing']);
  });

  it('is not touched when the create fails', async () => {
    const result = await withInventory({
      POST: () => Response.json({ error: 'nope' }, { status: 400 }),
    });
    expect(result.order).toEqual([]);
    expect([result.old, result.new]).toEqual(['Billing', undefined]);
  });
});

describe('the rotate route', () => {
  // The BFF owns `/api/g2/keys/<hash>/rotate` only while g2way has no such
  // endpoint. When one appears, proxy it instead and retire the orchestration.
  it('shadows no endpoint of the gateway', () => {
    expect(Object.keys(spec.paths).filter((path) => /\/rotate\b/.test(path))).toEqual([]);
  });
});
