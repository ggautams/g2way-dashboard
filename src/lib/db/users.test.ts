import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase, type DashboardDatabase } from '.';
import * as pgSchema from './schema/pg';
import {
  createFirstOwner,
  findUserByEmail,
  findUserById,
  hasUsers,
  type DataHandle,
  type NewUser,
} from './users';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';

const ada: NewUser = { email: '  Ada@Example.com ', name: ' Ada ', passwordHash: 'hash-a' };
const bob: NewUser = { email: 'bob@example.com', name: 'Bob', passwordHash: 'hash-b' };

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

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('users repository on %s', (_name, open) => {
  it('bootstraps the first owner, normalising email and name', async () => {
    const handle = await open();
    expect(await hasUsers(handle, ORG)).toBe(false);

    const owner = await createFirstOwner(handle, ORG, ada);
    expect(owner).toMatchObject({
      orgId: ORG,
      email: 'ada@example.com',
      name: 'Ada',
      role: 'owner',
      disabled: false,
    });
    expect(await hasUsers(handle, ORG)).toBe(true);
  });

  it('refuses a second bootstrap once any user exists', async () => {
    const handle = await open();
    expect(await createFirstOwner(handle, ORG, ada)).not.toBeNull();
    expect(await createFirstOwner(handle, ORG, bob)).toBeNull();
    expect(await findUserByEmail(handle, ORG, bob.email)).toBeUndefined();
  });

  it('yields exactly one owner from concurrent submits', async () => {
    const handle = await open();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createFirstOwner(handle, ORG, { ...bob, email: `racer${i}@example.com` }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('scopes everything to the org', async () => {
    const handle = await open();
    const owner = await createFirstOwner(handle, ORG, ada);
    expect(await hasUsers(handle, 'another-org')).toBe(false);
    expect(await findUserById(handle, 'another-org', owner!.id)).toBeUndefined();
    expect(await findUserByEmail(handle, 'another-org', ada.email)).toBeUndefined();
    // Another org bootstraps independently.
    expect(await createFirstOwner(handle, 'another-org', bob)).not.toBeNull();
  });

  it('finds users by id and by email in any case', async () => {
    const handle = await open();
    const owner = await createFirstOwner(handle, ORG, ada);
    expect(await findUserById(handle, ORG, owner!.id)).toEqual(owner);
    expect(await findUserByEmail(handle, ORG, 'ADA@example.COM')).toEqual(owner);
    expect(await findUserById(handle, ORG, crypto.randomUUID())).toBeUndefined();
  });
});

describe('bootstrap across separate SQLite connections', () => {
  // Two processes (or dev-server workers) share one file: each opens its own
  // connection, so the lock must live in the database, not in this process.
  it('yields exactly one owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g2dash-users-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'dashboard.db');
    const connections: DashboardDatabase[] = [
      openDatabase({ dialect: 'sqlite', path }),
      openDatabase({ dialect: 'sqlite', path }),
    ];
    cleanup.push(() => Promise.all(connections.map((c) => c.close())).then(() => {}));
    await migrateDatabase(connections[0]);

    const results = await Promise.all(
      connections.map((connection, i) =>
        createFirstOwner(connection, ORG, { ...bob, email: `conn${i}@example.com` }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await hasUsers(connections[1], ORG)).toBe(true);
  });
});

// Needs a live Postgres; `make test-pg` starts one in Docker and sets TEST_POSTGRES_URL.
describe.skipIf(!process.env.TEST_POSTGRES_URL)('users repository on node-postgres (live)', () => {
  it('yields exactly one owner from concurrent submits on separate connections', async () => {
    const database = openDatabase({ dialect: 'postgres', url: process.env.TEST_POSTGRES_URL! });
    cleanup.push(() => database.close());
    await migrateDatabase(database);
    const orgId = `live-${crypto.randomUUID()}`;
    // The pool hands each concurrent transaction its own connection.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createFirstOwner(database, orgId, { ...bob, email: `racer${i}@example.com` }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    if (database.dialect === 'postgres') {
      const { db, schema } = database;
      const { eq } = await import('drizzle-orm');
      await db.delete(schema.users).where(eq(schema.users.orgId, orgId));
    }
  });
});
