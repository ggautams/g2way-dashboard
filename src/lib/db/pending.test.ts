import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import { recordAudit, type AuditRecord } from './audit';
import { listPendingChanges } from './pending';
import * as pgSchema from './schema/pg';
import type { DataHandle } from './users';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';

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

const actor = { id: 'u1', email: 'ada@example.com', role: 'editor' as const };

function write(
  action: string,
  target: string,
  environment = 'prod',
  outcome: AuditRecord['outcome'] = 'success',
): AuditRecord {
  return { actor, action, target, environment, outcome };
}

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('pending changes on %s', (_name, open) => {
  const targets = async (handle: DataHandle, environment = 'prod', org = ORG) =>
    (await listPendingChanges(handle, org, environment)).changes.map(
      (c) => `${c.action} ${c.target}`,
    );

  it('are the successful API and policy writes to an environment since it last reloaded', async () => {
    const handle = await open();
    for (const record of [
      write('api.update', 'orders'),
      write('api.create', 'users', 'dev'),
      write('api.delete', 'old', 'prod', 'failure'),
      write('key.create', 'hash'),
      write('policy.update', 'gold'),
    ]) {
      await recordAudit(handle, ORG, record);
    }
    expect(await targets(handle)).toEqual(['api.update orders', 'policy.update gold']);
    expect(await targets(handle, 'dev')).toEqual(['api.create users']);
    expect(await targets(handle, 'prod', 'another-org')).toEqual([]);
    expect((await listPendingChanges(handle, ORG, 'prod')).lastReloadAt).toBeNull();
  });

  it('clear on a successful reload of that environment only', async () => {
    const handle = await open();
    await recordAudit(handle, ORG, write('api.update', 'orders'));
    await recordAudit(handle, ORG, write('api.update', 'users', 'dev'));
    await recordAudit(handle, ORG, { ...write('gateway.reload', ''), outcome: 'failure' });
    expect(await targets(handle)).toEqual(['api.update orders']);

    await recordAudit(handle, ORG, write('gateway.reload', ''));
    expect(await targets(handle)).toEqual([]);
    expect(await targets(handle, 'dev')).toEqual(['api.update users']);
    expect((await listPendingChanges(handle, ORG, 'prod')).lastReloadAt).toBeInstanceOf(Date);

    // Written in the same millisecond as the reload, but after it: still pending.
    await recordAudit(handle, ORG, write('api.delete', 'orders'));
    expect(await targets(handle)).toEqual(['api.delete orders']);
  });
});
