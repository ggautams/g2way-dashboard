import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, type SqliteDatabase } from '@/lib/db';
import { createFirstOwner } from '@/lib/db/users';
import { checkCredentials, resolveSessionUser } from './credentials';
import { hashPassword } from './password';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const PASSWORD = 'a long enough password';

const open: SqliteDatabase[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((database) => database.close()));
});

async function withOwner() {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  if (database.dialect !== 'sqlite') throw new Error('expected SQLite');
  open.push(database);
  await migrateDatabase(database);
  const owner = await createFirstOwner(database, ORG, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: await hashPassword(PASSWORD),
  });
  const disable = () =>
    database.db
      .update(database.schema.users)
      .set({ disabled: true })
      .where(eq(database.schema.users.id, owner!.id))
      .run();
  return { database, owner: owner!, disable };
}

describe('checkCredentials', () => {
  it('accepts the right password, with the email in any case', async () => {
    const { database, owner } = await withOwner();
    const result = await checkCredentials(database, ORG, ' ADA@example.com', PASSWORD);
    expect(result).toEqual({ ok: true, user: owner });
  });

  it('says only "invalid" for a wrong password or an unknown email', async () => {
    const { database } = await withOwner();
    expect(await checkCredentials(database, ORG, 'ada@example.com', 'wrong password!')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await checkCredentials(database, ORG, 'nobody@example.com', PASSWORD)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await checkCredentials(database, 'another-org', 'ada@example.com', PASSWORD)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a disabled user, but only reveals it given the right password', async () => {
    const { database, disable } = await withOwner();
    disable();
    expect(await checkCredentials(database, ORG, 'ada@example.com', PASSWORD)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(await checkCredentials(database, ORG, 'ada@example.com', 'wrong password!')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('resolveSessionUser', () => {
  it('returns the live account behind a session', async () => {
    const { database, owner } = await withOwner();
    expect(await resolveSessionUser(database, ORG, { userId: owner.id, orgId: ORG })).toEqual(
      owner,
    );
  });

  it('drops a user disabled mid-session', async () => {
    const { database, owner, disable } = await withOwner();
    disable();
    expect(await resolveSessionUser(database, ORG, { userId: owner.id, orgId: ORG })).toBeNull();
  });

  it('drops a deleted user, a token from another org, and no session', async () => {
    const { database, owner } = await withOwner();
    expect(await resolveSessionUser(database, ORG, null)).toBeNull();
    expect(await resolveSessionUser(database, ORG, { userId: owner.id })).toBeNull();
    expect(
      await resolveSessionUser(database, ORG, { userId: owner.id, orgId: 'another-org' }),
    ).toBeNull();
    database.db.delete(database.schema.users).run();
    expect(await resolveSessionUser(database, ORG, { userId: owner.id, orgId: ORG })).toBeNull();
  });
});
