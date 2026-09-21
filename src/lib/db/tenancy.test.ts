import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { recordSignIn } from '@/lib/auth/audit';
import { checkCredentials, resolveSessionUser } from '@/lib/auth/credentials';
import { hashPassword } from '@/lib/auth/password';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import { completeAudit, getAuditEntry, listAudit, recordAudit, type AuditRecord } from './audit';
import * as pgSchema from './schema/pg';
import {
  createFirstOwner,
  createUser,
  findUserByEmail,
  findUserById,
  hasUsers,
  listUsers,
  updateUser,
  type DataHandle,
} from './users';

/**
 * Cross-org isolation (ADR-0007): rows seeded under org A are invisible to,
 * and unmodifiable from, org B, through every data-access function. The orgs
 * are stand-ins: the real one always comes from config (`G2_ORG_ID`).
 */
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PASSWORD = 'a long enough password';

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

let passwordHash: string | undefined;

/** Org A: an owner, an editor and one audit row of its own. */
async function seedOrgA(handle: DataHandle) {
  passwordHash ??= await hashPassword(PASSWORD);
  const owner = (await createFirstOwner(handle, ORG_A, {
    email: 'owner@a.example',
    name: 'Owner A',
    passwordHash,
  }))!;
  const created = await createUser(handle, ORG_A, owner.id, {
    email: 'editor@a.example',
    name: 'Editor A',
    passwordHash,
    role: 'editor',
  });
  if (!created.ok) throw new Error(created.message);
  const auditId = await recordAudit(handle, ORG_A, {
    actor: { id: owner.id, email: owner.email, role: owner.role },
    action: 'api.update',
    target: 'orders',
    outcome: 'pending',
  });
  return { owner, editor: created.after, auditId };
}

/** Org A's users and audit rows exactly as they stand, for before/after comparison. */
async function snapshotOrgA(handle: DataHandle) {
  return {
    users: await listUsers(handle, ORG_A),
    audit: (await listAudit(handle, ORG_A)).entries,
  };
}

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('cross-org isolation on %s', (_name, open) => {
  it('hides org A’s users from org B: list, get by id, get by email, emptiness', async () => {
    const handle = await open();
    const { owner, editor } = await seedOrgA(handle);

    expect(await hasUsers(handle, ORG_B)).toBe(false);
    expect(await listUsers(handle, ORG_B)).toEqual([]);
    for (const id of [owner.id, editor.id]) {
      expect(await findUserById(handle, ORG_B, id)).toBeUndefined();
    }
    for (const email of [owner.email, editor.email]) {
      expect(await findUserByEmail(handle, ORG_B, email)).toBeUndefined();
    }
    // And org A still sees its own.
    expect((await listUsers(handle, ORG_A)).map((u) => u.email)).toEqual([
      'owner@a.example',
      'editor@a.example',
    ]);
  });

  it('bootstraps each org independently, and never re-bootstraps org A from org B', async () => {
    const handle = await open();
    const { owner } = await seedOrgA(handle);
    const before = await snapshotOrgA(handle);

    // Org A has users, so org A cannot bootstrap again...
    expect(await createFirstOwner(handle, ORG_A, { ...owner, email: 'x@a.example' })).toBeNull();
    // ...but org B is empty, so it can — even reusing org A's owner email.
    const ownerB = await createFirstOwner(handle, ORG_B, {
      email: owner.email,
      name: 'Owner B',
      passwordHash: 'h',
    });
    expect(ownerB).toMatchObject({ orgId: ORG_B, email: owner.email, role: 'owner' });
    expect(ownerB!.id).not.toBe(owner.id);
    expect(await createFirstOwner(handle, ORG_B, { ...owner, email: 'y@b.example' })).toBeNull();

    // Org A is untouched: the same users, and org B's bootstrap audit row is org B's.
    const after = await snapshotOrgA(handle);
    expect(after.users).toEqual(before.users);
    expect(after.audit).toEqual(before.audit);
    expect((await listAudit(handle, ORG_B)).entries.map((e) => e.action)).toEqual([
      'auth.bootstrap',
    ]);
  });

  it('refuses org A’s owner acting in org B: no account, no write, the refusal logged in B', async () => {
    const handle = await open();
    const { owner, editor } = await seedOrgA(handle);
    await createFirstOwner(handle, ORG_B, {
      email: 'owner@b.example',
      name: 'B',
      passwordHash: 'h',
    });
    const before = await snapshotOrgA(handle);

    // Org A's owner id means nothing in org B.
    expect(
      await createUser(handle, ORG_B, owner.id, {
        email: 'intruder@b.example',
        name: 'Intruder',
        passwordHash: 'h',
        role: 'owner',
      }),
    ).toMatchObject({ ok: false, reason: 'denied' });
    expect(await updateUser(handle, ORG_B, owner.id, editor.id, { role: 'admin' })).toMatchObject({
      ok: false,
      reason: 'denied',
    });
    expect(await findUserByEmail(handle, ORG_B, 'intruder@b.example')).toBeUndefined();

    const after = await snapshotOrgA(handle);
    expect(after).toEqual(before);
    expect(
      (await listAudit(handle, ORG_B, { outcome: 'denied' })).entries.map((e) => e.action).sort(),
    ).toEqual(['user.create', 'user.role_change']);
  });

  it('answers not-found when org B’s own owner targets org A’s accounts', async () => {
    const handle = await open();
    const { owner, editor } = await seedOrgA(handle);
    const ownerB = (await createFirstOwner(handle, ORG_B, {
      email: 'owner@b.example',
      name: 'B',
      passwordHash: 'h',
    }))!;
    const before = await snapshotOrgA(handle);

    for (const change of [{ role: 'viewer' as const }, { disabled: true }]) {
      for (const target of [owner.id, editor.id]) {
        expect(await updateUser(handle, ORG_B, ownerB.id, target, change)).toMatchObject({
          ok: false,
          reason: 'not-found',
        });
      }
    }
    expect(await snapshotOrgA(handle)).toMatchObject({ users: before.users });
    // Nothing of org B's leaks into org A's view either.
    expect(await findUserById(handle, ORG_A, ownerB.id)).toBeUndefined();
  });

  it('keeps the last-owner rule per org: org B’s owners neither count for nor reach org A', async () => {
    const handle = await open();
    const { owner } = await seedOrgA(handle);
    // Org B has plenty of owners; org A has exactly one.
    const ownerB = (await createFirstOwner(handle, ORG_B, {
      email: 'owner@b.example',
      name: 'B',
      passwordHash: 'h',
    }))!;
    for (const email of ['two@b.example', 'three@b.example']) {
      const result = await createUser(handle, ORG_B, ownerB.id, {
        email,
        name: email,
        passwordHash: 'h',
        role: 'owner',
      });
      expect(result.ok).toBe(true);
    }

    // No org B owner can demote or disable org A's only owner, from either org.
    for (const org of [ORG_A, ORG_B]) {
      expect(await updateUser(handle, org, ownerB.id, owner.id, { role: 'viewer' })).toMatchObject({
        ok: false,
      });
      expect(await updateUser(handle, org, ownerB.id, owner.id, { disabled: true })).toMatchObject({
        ok: false,
      });
    }
    expect(await findUserById(handle, ORG_A, owner.id)).toMatchObject({
      role: 'owner',
      disabled: false,
    });

    // Within org B, three active owners: one may be demoted by another.
    const [, second] = (await listUsers(handle, ORG_B)).filter((u) => u.role === 'owner');
    expect(await updateUser(handle, ORG_B, ownerB.id, second.id, { role: 'admin' })).toMatchObject({
      ok: true,
    });
  });

  it('never signs org A’s accounts into org B, and logs the attempt in org B only', async () => {
    const handle = await open();
    const { owner } = await seedOrgA(handle);
    const before = await snapshotOrgA(handle);

    expect(await checkCredentials(handle, ORG_A, owner.email, PASSWORD)).toMatchObject({
      ok: true,
    });
    const result = await checkCredentials(handle, ORG_B, owner.email, PASSWORD);
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    await recordSignIn(handle, ORG_B, owner.email, result);

    // A session for org A's owner, presented to a dashboard configured for org B.
    expect(await resolveSessionUser(handle, ORG_B, { userId: owner.id, orgId: ORG_A })).toBeNull();
    // Even a token claiming org B cannot name org A's user.
    expect(await resolveSessionUser(handle, ORG_B, { userId: owner.id, orgId: ORG_B })).toBeNull();

    expect(await snapshotOrgA(handle)).toEqual(before);
    expect((await listAudit(handle, ORG_B)).entries).toEqual([
      expect.objectContaining({
        orgId: ORG_B,
        action: 'auth.sign_in',
        outcome: 'failure',
        actorId: null,
      }),
    ]);
  });

  it('hides org A’s audit rows from org B: list, filters, get by id', async () => {
    const handle = await open();
    const { auditId } = await seedOrgA(handle);

    expect((await listAudit(handle, ORG_B)).entries).toEqual([]);
    for (const filter of [
      { action: 'api.' },
      { target: 'orders' },
      { outcome: 'pending' as const },
    ]) {
      expect((await listAudit(handle, ORG_B, filter)).entries).toEqual([]);
    }
    expect(await getAuditEntry(handle, ORG_B, auditId)).toBeUndefined();
    expect(await getAuditEntry(handle, ORG_A, auditId)).toMatchObject({ orgId: ORG_A });
  });

  it('cannot complete (rewrite) org A’s audit row from org B', async () => {
    const handle = await open();
    const { auditId } = await seedOrgA(handle);
    const before = await getAuditEntry(handle, ORG_A, auditId);

    const forged: AuditRecord = {
      actor: null,
      action: 'api.update',
      target: 'orders',
      outcome: 'success',
      after: { forged: true },
    };
    await completeAudit(handle, ORG_B, auditId, forged);

    expect(await getAuditEntry(handle, ORG_A, auditId)).toEqual(before);
    expect(await getAuditEntry(handle, ORG_B, auditId)).toBeUndefined();
  });
});
