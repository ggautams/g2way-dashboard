import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import Sqlite from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import { completeAudit, getAuditEntry, listAudit, recordAudit, type AuditRecord } from './audit';
import * as pgSchema from './schema/pg';
import type { DataHandle } from './users';

// Stand-in orgs: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const OTHER_ORG = 'another-org';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function sqliteMemory(): Promise<DataHandle> {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  return database;
}

async function pglite(): Promise<DataHandle> {
  const client = new PGlite();
  cleanup.push(() => client.close());
  const db = drizzlePglite(client, { schema: pgSchema });
  await migratePglite(db, { migrationsFolder: migrationsFolder('postgres') });
  return { dialect: 'postgres', db, schema: pgSchema };
}

const ada = { id: 'u-ada', email: 'ada@example.com', role: 'editor' as const };
const bob = { id: 'u-bob', email: 'bob@example.com', role: 'admin' as const };

const entry = (overrides: Partial<AuditRecord>): AuditRecord => ({
  actor: ada,
  action: 'api.update',
  target: 'httpbin',
  outcome: 'success',
  ...overrides,
});

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('audit log on %s', (_name, open) => {
  it('records a row, redacting its snapshots on the way in', async () => {
    const handle = await open();
    const id = await recordAudit(
      handle,
      ORG,
      entry({
        before: { auth: { secret: 'old-secret' }, listen_path: '/a/' },
        after: { auth: { secret: 'new-secret' }, listen_path: '/b/' },
        request: { auth: { secret: 'new-secret' } },
        gateway: { method: 'PUT', path: '/g2/apis/httpbin', status: 200 },
        environment: 'dev',
        notes: ['one', 'two'],
      }),
    );
    const row = await getAuditEntry(handle, ORG, id);
    expect(row).toMatchObject({
      orgId: ORG,
      actorId: 'u-ada',
      actorEmail: 'ada@example.com',
      actorRole: 'editor',
      before: { auth: { secret: '[redacted]' }, listen_path: '/a/' },
      after: { auth: { secret: '[redacted: changed]' }, listen_path: '/b/' },
      request: { auth: { secret: '[redacted]' } },
      gatewayMethod: 'PUT',
      gatewayStatus: 200,
      environment: 'dev',
      note: 'one; two',
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row)).not.toMatch(/old-secret|new-secret/);
  });

  it('completes a pending row in place', async () => {
    const handle = await open();
    const pending = entry({ outcome: 'pending', gateway: { method: 'POST', path: '/g2/reload' } });
    const id = await recordAudit(handle, ORG, pending);
    await completeAudit(handle, ORG, id, {
      ...pending,
      outcome: 'failure',
      gateway: { method: 'POST', path: '/g2/reload', status: 503 },
      error: 'storage unavailable',
    });
    expect(await getAuditEntry(handle, ORG, id)).toMatchObject({
      outcome: 'failure',
      gatewayStatus: 503,
      error: 'storage unavailable',
    });
  });

  it('lists newest first, filters, and pages', async () => {
    const handle = await open();
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 23, 12, minutes));
    const ids: string[] = [];
    for (const [i, record] of [
      entry({ action: 'api.update', target: 'httpbin' }),
      entry({ action: 'api.delete', target: 'petstore', actor: bob }),
      entry({ action: 'key.create', target: 'abc123', actor: bob, outcome: 'denied' }),
      entry({ action: 'user.role_change', target: 'carol@example.com' }),
    ].entries()) {
      const id = await recordAudit(handle, ORG, record);
      ids.push(id);
      // Pin the timestamps so the order is defined.
      if (handle.dialect === 'sqlite') {
        handle.db
          .update(handle.schema.auditLog)
          .set({ createdAt: at(i) })
          .where(eq(handle.schema.auditLog.id, id))
          .run();
      } else {
        await handle.db
          .update(handle.schema.auditLog)
          .set({ createdAt: at(i) })
          .where(eq(handle.schema.auditLog.id, id));
      }
    }
    await recordAudit(handle, OTHER_ORG, entry({ action: 'api.update' }));

    const all = await listAudit(handle, ORG);
    expect(all.entries.map((e) => e.action)).toEqual([
      'user.role_change',
      'key.create',
      'api.delete',
      'api.update',
    ]);
    expect(all.hasMore).toBe(false);
    expect('before' in all.entries[0]).toBe(false);

    const actions = async (filter: Parameters<typeof listAudit>[2]) =>
      (await listAudit(handle, ORG, filter)).entries.map((e) => e.action);
    expect(await actions({ action: 'api.' })).toEqual(['api.delete', 'api.update']);
    expect(await actions({ actor: 'BOB@' })).toEqual(['key.create', 'api.delete']);
    expect(await actions({ target: 'store' })).toEqual(['api.delete']);
    expect(await actions({ outcome: 'denied' })).toEqual(['key.create']);
    expect(await actions({ from: at(1), to: at(3) })).toEqual(['key.create', 'api.delete']);
    // LIKE wildcards in the input match literally.
    expect(await actions({ action: '%' })).toEqual([]);
    expect(await actions({ target: '_' })).toEqual([]);

    const first = await listAudit(handle, ORG, {}, { limit: 3 });
    expect(first).toMatchObject({ hasMore: true });
    expect(first.entries).toHaveLength(3);
    const second = await listAudit(handle, ORG, {}, { limit: 3, offset: 3 });
    expect(second.entries.map((e) => e.id)).toEqual([ids[0]]);
    expect(second.hasMore).toBe(false);
  });

  it('orders rows written in the same millisecond by insertion', async () => {
    const handle = await open();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 8, 23, 12, 0, 0, 500));
      for (const action of ['a.first', 'a.second', 'a.third', 'a.fourth']) {
        await recordAudit(handle, ORG, entry({ action }));
      }
    } finally {
      vi.useRealTimers();
    }
    const { entries } = await listAudit(handle, ORG);
    expect(new Set(entries.map((e) => e.createdAt.getTime())).size).toBe(1);
    expect(entries.map((e) => e.action)).toEqual(['a.fourth', 'a.third', 'a.second', 'a.first']);
  });

  it('keeps orgs apart', async () => {
    const handle = await open();
    const id = await recordAudit(handle, OTHER_ORG, entry({}));
    expect(await getAuditEntry(handle, ORG, id)).toBeUndefined();
    expect((await listAudit(handle, ORG)).entries).toEqual([]);
  });
});

// The 0001 migrations are hand-edited (ADR-0006): prove they carry an existing
// row across, on both dialects.
describe('0001_audit_outcomes migration', () => {
  const statements = (dialect: 'sqlite' | 'pg', file: string) =>
    readFileSync(join(process.cwd(), 'drizzle', dialect, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((sql) => sql.trim())
      .filter(Boolean);

  const legacyRow = `insert into audit_log (id, org_id, actor_id, actor_email, action, created_at)
    values ('r1', '${ORG}', 'u1', 'ada@example.com', 'api.update', 1)`;

  it('keeps an existing row on SQLite, marked as predating outcomes', () => {
    const client = new Sqlite(':memory:');
    cleanup.push(() => void client.close());
    for (const sql of statements('sqlite', '0000_init.sql')) client.exec(sql);
    client.exec(legacyRow);
    for (const sql of statements('sqlite', '0001_audit_outcomes.sql')) client.exec(sql);
    expect(client.prepare('select outcome, note, actor_email from audit_log').get()).toEqual({
      outcome: 'success',
      note: 'recorded before outcomes were tracked',
      actor_email: 'ada@example.com',
    });
    expect(() =>
      client.exec(
        `insert into audit_log (id, org_id, action, created_at) values ('r2', 'o', 'a', 1)`,
      ),
    ).toThrow(/NOT NULL/);
  });

  it('keeps an existing row on Postgres, then requires an outcome', async () => {
    const client = new PGlite();
    cleanup.push(() => client.close());
    for (const sql of statements('pg', '0000_init.sql')) await client.exec(sql);
    await client.exec(legacyRow.replace(', 1)', ', now())'));
    for (const sql of statements('pg', '0001_audit_outcomes.sql')) await client.exec(sql);
    const { rows } = await client.query('select outcome from audit_log');
    expect(rows).toEqual([{ outcome: 'success' }]);
    await expect(
      client.exec(
        `insert into audit_log (id, org_id, action, created_at) values ('r2', 'o', 'a', now())`,
      ),
    ).rejects.toThrow(/null value/);
  });
});
