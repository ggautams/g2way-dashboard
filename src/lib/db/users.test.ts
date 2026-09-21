import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase, type DashboardDatabase } from '.';
import * as pgSchema from './schema/pg';
import type { Role } from './schema/shared';
import {
  createFirstOwner,
  createUser,
  findUserByEmail,
  findUserById,
  hasUsers,
  listUsers,
  removesLastActiveOwner,
  updateUser,
  type DataHandle,
  type NewUser,
  type User,
  type UserWriteResult,
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

/** A bootstrapped org: its owner, plus `create` to add accounts as that owner. */
async function seeded(handle: DataHandle) {
  const owner = (await createFirstOwner(handle, ORG, ada))!;
  const create = async (role: Role, email = `${role}@example.com`, actor = owner.id) => {
    const result = await createUser(handle, ORG, actor, {
      email,
      name: role,
      passwordHash: 'h',
      role,
    });
    if (!result.ok) throw new Error(result.message);
    return result.after;
  };
  return { owner, create };
}

function refusal(result: UserWriteResult) {
  return result.ok ? 'ok' : result.reason;
}

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('user management on %s', (_name, open) => {
  it('creates accounts, lists them oldest first and never exposes the hash', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const result = await createUser(handle, ORG, owner.id, {
      email: ' Viewer@Example.com',
      name: ' Vee ',
      passwordHash: 'h',
      role: 'viewer',
    });
    expect(result).toMatchObject({
      ok: true,
      before: null,
      after: { email: 'viewer@example.com', name: 'Vee', role: 'viewer', disabled: false },
    });
    await create('editor');
    const users = await listUsers(handle, ORG);
    // Oldest first; rows created within the same millisecond fall back to email order.
    expect(users[0].id).toBe(owner.id);
    expect(users.map((u) => u.role).sort()).toEqual(['editor', 'owner', 'viewer']);
    for (const user of users) expect(user).not.toHaveProperty('passwordHash');
    expect(await listUsers(handle, 'another-org')).toEqual([]);
  });

  it('refuses a duplicate email in any case', async () => {
    const handle = await open();
    const { owner } = await seeded(handle);
    const result = await createUser(handle, ORG, owner.id, {
      ...bob,
      email: 'ADA@example.com',
      role: 'viewer',
    });
    expect(refusal(result)).toBe('email-taken');
  });

  it('lets an admin manage only accounts below admin', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const admin = await create('admin');
    const other = await create('admin', 'admin2@example.com');
    const viewer = await create('viewer');

    // Creating: below admin only.
    for (const role of ['owner', 'admin'] as const) {
      const result = await createUser(handle, ORG, admin.id, { ...bob, role });
      expect(refusal(result), role).toBe('denied');
    }
    expect((await createUser(handle, ORG, admin.id, { ...bob, role: 'editor' })).ok).toBe(true);

    // Modifying: never an owner or another admin, never promote to admin.
    expect(refusal(await updateUser(handle, ORG, admin.id, owner.id, { disabled: true }))).toBe(
      'denied',
    );
    expect(refusal(await updateUser(handle, ORG, admin.id, other.id, { role: 'viewer' }))).toBe(
      'denied',
    );
    expect(refusal(await updateUser(handle, ORG, admin.id, viewer.id, { role: 'admin' }))).toBe(
      'denied',
    );
    const promoted = await updateUser(handle, ORG, admin.id, viewer.id, { role: 'editor' });
    expect(promoted).toMatchObject({
      ok: true,
      before: { role: 'viewer' },
      after: { role: 'editor' },
    });
  });

  it('refuses users below admin, and anyone changing their own account', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const editor = await create('editor');
    const viewer = await create('viewer');
    expect(refusal(await updateUser(handle, ORG, editor.id, viewer.id, { disabled: true }))).toBe(
      'denied',
    );
    expect(refusal(await createUser(handle, ORG, editor.id, { ...bob, role: 'viewer' }))).toBe(
      'denied',
    );
    expect(refusal(await updateUser(handle, ORG, editor.id, editor.id, { role: 'owner' }))).toBe(
      'denied',
    );
    expect(refusal(await updateUser(handle, ORG, owner.id, owner.id, { role: 'admin' }))).toBe(
      'denied',
    );
    expect(refusal(await updateUser(handle, ORG, owner.id, owner.id, { disabled: true }))).toBe(
      'denied',
    );
  });

  it('re-reads the actor: a disabled or demoted actor cannot write', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const admin = await create('admin');
    const viewer = await create('viewer');
    await updateUser(handle, ORG, owner.id, admin.id, { disabled: true });
    expect(refusal(await updateUser(handle, ORG, admin.id, viewer.id, { role: 'editor' }))).toBe(
      'denied',
    );
    await updateUser(handle, ORG, owner.id, admin.id, { disabled: false });
    await updateUser(handle, ORG, owner.id, admin.id, { role: 'editor' });
    expect(refusal(await updateUser(handle, ORG, admin.id, viewer.id, { role: 'editor' }))).toBe(
      'denied',
    );
  });

  it('answers not-found for another org’s user', async () => {
    const handle = await open();
    const { owner } = await seeded(handle);
    const stranger = (await createFirstOwner(handle, 'another-org', bob))!;
    expect(refusal(await updateUser(handle, ORG, owner.id, stranger.id, { disabled: true }))).toBe(
      'not-found',
    );
    expect((await findUserById(handle, 'another-org', stranger.id))?.disabled).toBe(false);
  });

  it('lets an owner manage other owners while another active owner remains', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const second = await create('owner');
    const demoted = await updateUser(handle, ORG, owner.id, second.id, { role: 'admin' });
    expect(demoted).toMatchObject({ ok: true, after: { role: 'admin' } });
    const back = await updateUser(handle, ORG, owner.id, second.id, { role: 'owner' });
    expect(back.ok).toBe(true);
    expect((await updateUser(handle, ORG, second.id, owner.id, { disabled: true })).ok).toBe(true);
  });

  it('never leaves the org without an active owner when two owners demote each other at once', async () => {
    const handle = await open();
    const { owner, create } = await seeded(handle);
    const second = await create('owner');
    const results = await Promise.all([
      updateUser(handle, ORG, owner.id, second.id, { role: 'viewer' }),
      updateUser(handle, ORG, second.id, owner.id, { disabled: true }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const owners = (await listUsers(handle, ORG)).filter((u) => u.role === 'owner' && !u.disabled);
    expect(owners).toHaveLength(1);
  });
});

describe('removesLastActiveOwner', () => {
  const owner: Pick<User, 'role' | 'disabled'> = { role: 'owner', disabled: false };
  it('refuses demoting or disabling the only active owner', () => {
    expect(removesLastActiveOwner(owner, { role: 'admin' }, 1)).toBe(true);
    expect(removesLastActiveOwner(owner, { disabled: true }, 1)).toBe(true);
  });
  it('allows it while another active owner remains, and ignores non-removals', () => {
    expect(removesLastActiveOwner(owner, { role: 'admin' }, 2)).toBe(false);
    expect(removesLastActiveOwner(owner, { role: 'owner' }, 1)).toBe(false);
    expect(removesLastActiveOwner(owner, { disabled: false }, 1)).toBe(false);
    expect(removesLastActiveOwner({ role: 'owner', disabled: true }, { role: 'viewer' }, 1)).toBe(
      false,
    );
    expect(removesLastActiveOwner({ role: 'admin', disabled: false }, { disabled: true }, 1)).toBe(
      false,
    );
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

  it('keeps an active owner when two owners on separate connections demote each other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g2dash-users-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'dashboard.db');
    const connections: DashboardDatabase[] = [
      openDatabase({ dialect: 'sqlite', path }),
      openDatabase({ dialect: 'sqlite', path }),
    ];
    cleanup.push(() => Promise.all(connections.map((c) => c.close())).then(() => {}));
    await migrateDatabase(connections[0]);
    const first = (await createFirstOwner(connections[0], ORG, ada))!;
    const second = await createUser(connections[0], ORG, first.id, { ...bob, role: 'owner' });
    if (!second.ok) throw new Error(second.message);

    const results = await Promise.all([
      updateUser(connections[0], ORG, first.id, second.after.id, { disabled: true }),
      updateUser(connections[1], ORG, second.after.id, first.id, { role: 'viewer' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const owners = (await listUsers(connections[1], ORG)).filter(
      (u) => u.role === 'owner' && !u.disabled,
    );
    expect(owners).toHaveLength(1);
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

  it('keeps an active owner when two owners demote each other on separate connections', async () => {
    const database = openDatabase({ dialect: 'postgres', url: process.env.TEST_POSTGRES_URL! });
    cleanup.push(() => database.close());
    await migrateDatabase(database);
    const orgId = `live-${crypto.randomUUID()}`;
    const first = (await createFirstOwner(database, orgId, ada))!;
    const second = await createUser(database, orgId, first.id, { ...bob, role: 'owner' });
    if (!second.ok) throw new Error(second.message);
    const results = await Promise.all([
      updateUser(database, orgId, first.id, second.after.id, { disabled: true }),
      updateUser(database, orgId, second.after.id, first.id, { role: 'viewer' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const owners = (await listUsers(database, orgId)).filter(
      (u) => u.role === 'owner' && !u.disabled,
    );
    expect(owners).toHaveLength(1);
    if (database.dialect === 'postgres') {
      const { db, schema } = database;
      const { eq } = await import('drizzle-orm');
      await db.delete(schema.users).where(eq(schema.users.orgId, orgId));
    }
  });
});
