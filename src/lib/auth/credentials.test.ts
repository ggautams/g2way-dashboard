import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, type SqliteDatabase } from '@/lib/db';
import { createFirstOwner } from '@/lib/db/users';
import { attemptSignIn, checkCredentials, resolveSessionUser } from './credentials';
import { hashPassword } from './password';
import { THROTTLE_POLICY } from './throttle';

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

describe('attemptSignIn (throttled)', () => {
  const EMAIL_LIMIT = THROTTLE_POLICY.limits.email;
  const wrong = { email: 'ada@example.com', password: 'wrong password!', client: '192.0.2.1' };

  it('refuses even the right password once the email has too many failures', async () => {
    const { database } = await withOwner();
    for (let i = 0; i < EMAIL_LIMIT; i += 1) {
      expect(await attemptSignIn(database, ORG, { ...wrong, client: `192.0.2.${i}` })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(
      await attemptSignIn(database, ORG, { ...wrong, password: PASSWORD, client: '198.51.100.9' }),
    ).toEqual({ ok: false, reason: 'throttled', kind: 'email' });
  });

  it('clears the email count on a right password, so failures must be consecutive', async () => {
    const { database, owner } = await withOwner();
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < EMAIL_LIMIT - 1; i += 1) await attemptSignIn(database, ORG, wrong);
      expect(await attemptSignIn(database, ORG, { ...wrong, password: PASSWORD })).toEqual({
        ok: true,
        user: owner,
      });
    }
  });

  it('does not count a disabled account (the password was right)', async () => {
    const { database, disable } = await withOwner();
    disable();
    for (let i = 0; i < EMAIL_LIMIT + 1; i += 1) {
      expect(await attemptSignIn(database, ORG, { ...wrong, password: PASSWORD })).toEqual({
        ok: false,
        reason: 'disabled',
      });
    }
  });
});

describe('resolveSessionUser after a password change (ADR-0004 §9)', () => {
  it('ends sessions signed in before the change, and keeps later ones', async () => {
    const { database, owner } = await withOwner();
    const session = { userId: owner.id, orgId: ORG, signedInAt: Date.now() - 60_000 };
    expect(await resolveSessionUser(database, ORG, session)).not.toBeNull();

    const changedAt = new Date();
    database.db
      .update(database.schema.users)
      .set({ passwordChangedAt: changedAt })
      .where(eq(database.schema.users.id, owner.id))
      .run();
    expect(await resolveSessionUser(database, ORG, session)).toBeNull();
    // A token from before `signedInAt` existed counts as older than any change.
    expect(await resolveSessionUser(database, ORG, { userId: owner.id, orgId: ORG })).toBeNull();
    expect(
      await resolveSessionUser(database, ORG, { ...session, signedInAt: changedAt.getTime() }),
    ).not.toBeNull();
  });
});
