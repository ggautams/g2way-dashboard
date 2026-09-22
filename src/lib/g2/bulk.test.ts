import { describe, expect, it } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import type { BulkAnswer, BulkRequest } from '@/lib/bulk/ops';
import type { AuditRecord } from '@/lib/db/audit';
import type { AuditSink, KeyInventoryRef } from './audit-trail';
import { BULK_ACTIONS, runBulkOperation } from './bulk';
import { parseEnvironments } from './environments';

// Stand-in org and secret: the real ones always come from config.
const ORG = 'org-under-test';
const SECRET = 'bulk-test-secret-do-not-leak';
const ORIGIN = 'http://dashboard.test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev,staging',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: SECRET,
  G2_ENV_STAGING_URL: 'http://gw-staging:9696',
  G2_ENV_STAGING_SECRET: `${SECRET}-staging`,
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const HMAC = 'hmac-secret-kept-not-logged';

/**
 * A fake gateway with keys A (active, hmac), B (revoked) and C (active), and
 * policies gold and silver. `refuse` makes a write to one id answer 400.
 */
function fakeGateway(refuse: Record<string, string> = {}) {
  const keys = new Map<string, Record<string, unknown>>([
    [A, { org_id: ORG, alias: 'a', active: true, hmac: { secret: HMAC } }],
    [B, { org_id: ORG, alias: 'b', active: false }],
    [C, { org_id: ORG, alias: 'c' }],
  ]);
  const policies = new Map<string, Record<string, unknown>>([
    ['gold', { policy_id: 'gold', name: 'Gold', org_id: ORG }],
    ['silver', { policy_id: 'silver', name: 'Silver', org_id: ORG }],
  ]);
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    expect(new Headers(init.headers).get('x-g2-authorization')).toBe(SECRET);
    const [, , collection, raw] = url.pathname.split('/');
    const id = decodeURIComponent(raw ?? '');
    const store = collection === 'keys' ? keys : policies;
    if (method !== 'GET' && refuse[id] !== undefined) {
      return Response.json({ error: refuse[id] }, { status: 400 });
    }
    if (!store.has(id)) {
      return Response.json(
        { error: `${collection === 'keys' ? 'key' : 'policy'} not found` },
        { status: 404 },
      );
    }
    if (method === 'GET') return Response.json(store.get(id));
    if (method === 'PUT') {
      store.set(id, JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)));
      return Response.json({ id, action: 'modified' });
    }
    store.delete(id);
    return Response.json({ id, action: 'deleted' });
  }) as typeof globalThis.fetch;
  return { keys, policies, calls, fetch };
}

/** An in-memory audit sink recording key-inventory drops too. */
function memoryAudit(options: { failRecord?: boolean } = {}) {
  const rows = new Map<string, AuditRecord>();
  const forgotten: KeyInventoryRef[] = [];
  const sink: AuditSink = {
    async record(record) {
      if (options.failRecord) throw new Error('disk full');
      const id = `row-${rows.size + 1}`;
      rows.set(id, structuredClone(record));
      return id;
    },
    async complete(id, record) {
      rows.set(id, structuredClone(record));
    },
    async forgetKey(key) {
      forgotten.push(key);
    },
  };
  return { sink, rows, forgotten };
}

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

async function bulk(
  body: BulkRequest | Record<string, unknown>,
  options: {
    role?: Role;
    refuse?: Record<string, string>;
    headers?: Record<string, string>;
    failRecord?: boolean;
  } = {},
) {
  const gateway = fakeGateway(options.refuse);
  const audit = memoryAudit({ failRecord: options.failRecord });
  const response = await runBulkOperation(
    new Request(`${ORIGIN}/api/g2/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    }),
    actorFor(options.role ?? 'admin'),
    { fetch: gateway.fetch, registry, audit: audit.sink },
  );
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  const rows = [...audit.rows.values()];
  return {
    response,
    body: JSON.parse(text) as BulkAnswer & { error?: string },
    gateway,
    rows,
    forgotten: audit.forgotten,
    summary: rows.find((row) => row.action.endsWith('.bulk')),
  };
}

describe('bulk key operations', () => {
  it('revokes each key with its own audited write and reports each one', async () => {
    const { response, body, gateway, rows, summary } = await bulk(
      { collection: 'keys', op: 'revoke', ids: [A, B, C] },
      { refuse: { [C]: 'invalid key session: storage is read-only' } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-g2-environment')).toBe('dev');
    expect(body.results).toEqual([
      { id: A, outcome: 'done', status: 200 },
      { id: B, outcome: 'unchanged', reason: 'already revoked' },
      // The gateway's own message, verbatim.
      { id: C, outcome: 'failed', error: 'invalid key session: storage is read-only', status: 400 },
    ]);

    // Only `active` changed; everything else (the hmac secret too) is kept.
    expect(gateway.keys.get(A)).toEqual({
      org_id: ORG,
      alias: 'a',
      active: false,
      hmac: { secret: HMAC },
    });
    // Every call by hash, scoped to the configured org.
    expect(gateway.calls).toContain(`PUT /g2/keys/${A}?hashed=true&org_id=${ORG}`);
    expect(gateway.calls.some((call) => call.startsWith(`PUT /g2/keys/${B}`))).toBe(false);

    // One key.update row per write, with its outcome; the unchanged key wrote nothing.
    const updates = rows.filter((row) => row.action === 'key.update');
    expect(updates.map((row) => [row.target, row.outcome])).toEqual(
      expect.arrayContaining([
        [A, 'success'],
        [C, 'failure'],
      ]),
    );
    expect(updates).toHaveLength(2);
    expect(updates.find((row) => row.target === C)?.error).toBe(
      'invalid key session: storage is read-only',
    );
    expect(summary).toMatchObject({
      action: BULK_ACTIONS.keys,
      environment: 'dev',
      outcome: 'failure',
      request: { op: 'revoke', ids: [A, B, C] },
    });
    expect(summary?.notes).toContain('1 done, 1 unchanged, 1 failed');
  });

  it('marks each part of a chunked selection in its summary audit row', async () => {
    const { response, summary } = await bulk({
      collection: 'keys',
      op: 'revoke',
      ids: [A],
      part: { index: 2, of: 3 },
    });
    expect(response.status).toBe(200);
    expect(summary).toMatchObject({
      request: { op: 'revoke', ids: [A], part: { index: 2, of: 3 } },
    });
    expect(summary?.notes?.some((note) => note.startsWith('part 2 of 3'))).toBe(true);
  });

  it('deletes by hash and drops each deleted key’s metadata, as the single delete does', async () => {
    const { body, gateway, rows, forgotten, summary } = await bulk({
      collection: 'keys',
      op: 'delete',
      ids: [A, 'd'.repeat(64)],
    });
    expect(body.results).toEqual([
      { id: A, outcome: 'done', status: 200 },
      { id: 'd'.repeat(64), outcome: 'failed', error: 'key not found', status: 404 },
    ]);
    expect(gateway.keys.has(A)).toBe(false);
    expect(forgotten.map((key) => key.keyHash)).toEqual([A]);
    expect(rows.filter((row) => row.action === 'key.delete')).toHaveLength(2);
    expect(summary?.outcome).toBe('failure');
  });

  it('assigns and unassigns one policy, keeping the rest of the session', async () => {
    const assigned = await bulk({
      collection: 'keys',
      op: 'assign-policy',
      ids: [A, C],
      policy: 'gold',
    });
    expect(assigned.body.results.map((r) => r.outcome)).toEqual(['done', 'done']);
    expect(assigned.gateway.keys.get(A)).toMatchObject({
      apply_policies: ['gold'],
      hmac: { secret: HMAC },
    });
    expect(assigned.summary?.outcome).toBe('success');

    const removed = await bulk({
      collection: 'keys',
      op: 'unassign-policy',
      ids: [A],
      policy: 'gold',
    });
    // The fake starts afresh: A applies no policy.
    expect(removed.body.results).toEqual([
      { id: A, outcome: 'unchanged', reason: 'applies no policy' },
    ]);
  });

  it('refuses a role without keys:write, audited once, nothing sent', async () => {
    const { response, body, gateway, rows } = await bulk(
      { collection: 'keys', op: 'delete', ids: [A] },
      { role: 'editor' },
    );
    expect(response.status).toBe(403);
    expect(body.error).toMatch(/lacks the keys:write permission/);
    expect(gateway.calls).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ action: 'key.bulk', outcome: 'denied' })]);
  });

  it('refuses a cross-site request', async () => {
    const { response, gateway } = await bulk(
      { collection: 'keys', op: 'revoke', ids: [A] },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(response.status).toBe(403);
    expect(gateway.calls).toEqual([]);
  });

  it('sends nothing when the summary row cannot be written (fail closed)', async () => {
    const { response, gateway } = await bulk(
      { collection: 'keys', op: 'revoke', ids: [A] },
      { failRecord: true },
    );
    expect(response.status).toBe(503);
    expect(gateway.calls).toEqual([]);
  });

  it('answers 400 for a malformed request', async () => {
    const { response, body } = await bulk({ collection: 'keys', op: 'rotate', ids: [A] });
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/keys support/);
  });

  it('honours the environment header', async () => {
    const gateway = fakeGateway();
    const audit = memoryAudit();
    const response = await runBulkOperation(
      new Request(`${ORIGIN}/api/g2/bulk`, {
        method: 'POST',
        headers: { 'x-g2-environment': 'nowhere' },
        body: JSON.stringify({ collection: 'keys', op: 'revoke', ids: [A] }),
      }),
      actorFor('admin'),
      { fetch: gateway.fetch, registry, audit: audit.sink },
    );
    expect(response.status).toBe(400);
    expect(gateway.calls).toEqual([]);
  });
});

describe('bulk policy delete', () => {
  it('deletes each policy with its own audited write; an editor may', async () => {
    const { body, gateway, rows, summary } = await bulk(
      { collection: 'policies', op: 'delete', ids: ['gold', 'silver', 'bronze'] },
      { role: 'editor', refuse: { silver: 'policy is locked' } },
    );
    expect(body.results).toEqual([
      { id: 'gold', outcome: 'done', status: 200 },
      { id: 'silver', outcome: 'failed', error: 'policy is locked', status: 400 },
      { id: 'bronze', outcome: 'failed', error: 'policy not found', status: 404 },
    ]);
    expect(gateway.policies.has('gold')).toBe(false);
    expect(gateway.calls).toContain(`DELETE /g2/policies/gold?org_id=${ORG}`);
    const deletes = rows.filter((row) => row.action === 'policy.delete');
    expect(deletes.map((row) => [row.target, row.outcome])).toEqual(
      expect.arrayContaining([
        ['gold', 'success'],
        ['silver', 'failure'],
        ['bronze', 'failure'],
      ]),
    );
    expect(summary).toMatchObject({ action: BULK_ACTIONS.policies, outcome: 'failure' });
  });

  it('refuses a viewer', async () => {
    const { response, gateway } = await bulk(
      { collection: 'policies', op: 'delete', ids: ['gold'] },
      { role: 'viewer' },
    );
    expect(response.status).toBe(403);
    expect(gateway.calls).toEqual([]);
  });
});
