import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import { listVersions, recordVersion, type VersionWrite } from './config-versions';
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
// Every class of secret ADR-0010 masks for readers: history must keep them all, for rollback.
const v1 = {
  api_id: 'orders',
  listen_path: '/v1/',
  auth: { mode: 'jwt', secret: 'shh' },
  target_url: 'https://svc:pw@orders.internal/api?api_key=live',
  transform_headers: { request: { add: { 'X-Upstream-Key': 'upstream-live' } } },
};
const v2 = { ...v1, listen_path: '/v2/' };

const write = (over: Partial<VersionWrite>): VersionWrite => ({
  environment: 'prod',
  kind: 'api',
  resourceId: 'orders',
  action: 'update',
  before: null,
  after: null,
  actor,
  auditId: 'audit-1',
  ...over,
});

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('config versions on %s', (_name, open) => {
  const history = (handle: DataHandle, environment = 'prod') =>
    listVersions(handle, ORG, { environment, kind: 'api', resourceId: 'orders' });

  it('keeps a baseline before the first write to something made elsewhere, unredacted', async () => {
    const handle = await open();
    await recordVersion(handle, ORG, write({ before: v1, after: v2 }));
    await recordVersion(handle, ORG, write({ before: v2, after: v1, auditId: 'audit-2' }));
    const versions = await history(handle);
    expect(versions.map((v) => [v.action, v.definition, v.auditId])).toEqual([
      ['update', v1, 'audit-2'],
      ['update', v2, 'audit-1'],
      ['baseline', v1, null],
    ]);
    expect(versions[2].actorEmail).toBeNull();
    expect(versions[0].actorEmail).toBe('ada@example.com');
  });

  it('keeps no baseline for a creation, and a null definition for a delete', async () => {
    const handle = await open();
    await recordVersion(handle, ORG, write({ action: 'create', after: v1 }));
    await recordVersion(handle, ORG, write({ action: 'delete', before: v1, after: null }));
    expect((await history(handle)).map((v) => [v.action, v.definition])).toEqual([
      ['delete', null],
      ['create', v1],
    ]);
  });

  it('keeps each environment and org apart', async () => {
    const handle = await open();
    await recordVersion(handle, ORG, write({ action: 'create', after: v1 }));
    await recordVersion(handle, ORG, write({ environment: 'dev', action: 'create', after: v2 }));
    expect(await history(handle)).toHaveLength(1);
    expect((await history(handle, 'dev'))[0].definition).toEqual(v2);
    expect(
      await listVersions(handle, 'another-org', {
        environment: 'prod',
        kind: 'api',
        resourceId: 'orders',
      }),
    ).toEqual([]);
  });
});
