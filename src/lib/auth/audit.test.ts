import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase, type SqliteDatabase } from '@/lib/db';
import { getAuditEntry, listAudit } from '@/lib/db/audit';
import { createFirstOwner } from '@/lib/db/users';
import { attemptedEmail, recordSignIn, recordSignOut } from './audit';
import { checkCredentials } from './credentials';
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
  const owner = (await createFirstOwner(database, ORG, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: await hashPassword(PASSWORD),
  }))!;
  const signIns = async () =>
    Promise.all(
      (await listAudit(database, ORG, { action: 'auth.sign' })).entries.map(
        async (e) => (await getAuditEntry(database, ORG, e.id))!,
      ),
    );
  return { database, owner, signIns };
}

async function attempt(database: SqliteDatabase, email: string, password: string) {
  await recordSignIn(database, ORG, email, await checkCredentials(database, ORG, email, password));
}

describe('sign-in audit', () => {
  it('records a successful sign-in and a sign-out as the user', async () => {
    const { database, owner, signIns } = await withOwner();
    await attempt(database, 'ADA@example.com', PASSWORD);
    await recordSignOut(database, ORG, owner);
    const rows = await signIns();
    expect(rows.map((r) => [r.action, r.outcome, r.actorEmail]).sort()).toEqual([
      ['auth.sign_in', 'success', 'ada@example.com'],
      ['auth.sign_out', 'success', 'ada@example.com'],
    ]);
  });

  it('records an unknown email and a wrong password identically, never the password', async () => {
    const { database, signIns } = await withOwner();
    await attempt(database, 'ada@example.com', 'wrong password guess');
    await attempt(database, 'nobody@example.com', 'wrong password guess');
    const rows = await signIns();
    const shape = rows.map(({ actorId, actorEmail, outcome, error, before, after, request }) => ({
      actorId,
      actorEmail,
      outcome,
      error,
      before,
      after,
      request,
    }));
    expect(shape[0]).toEqual(shape[1]);
    expect(shape[0]).toMatchObject({ actorId: null, outcome: 'failure' });
    expect(rows.map((r) => r.target).sort()).toEqual(['ada@example.com', 'nobody@example.com']);
    expect(JSON.stringify(rows)).not.toContain('wrong password guess');
  });

  it('does not keep a password typed into the email field', async () => {
    const { database, signIns } = await withOwner();
    await attempt(database, 'correct horse battery staple', PASSWORD);
    const [row] = await signIns();
    expect(row.target).toBe('[not an email address]');
    expect(JSON.stringify(row)).not.toContain('horse');
  });

  it('records a disabled account as denied', async () => {
    const { database, owner, signIns } = await withOwner();
    database.db.update(database.schema.users).set({ disabled: true }).run();
    await attempt(database, owner.email, PASSWORD);
    expect((await signIns())[0]).toMatchObject({
      outcome: 'denied',
      error: 'the account is disabled',
    });
  });

  it('records a throttled attempt as denied, noting the password was not checked', async () => {
    const { database, signIns } = await withOwner();
    await recordSignIn(database, ORG, 'Ada@Example.com', {
      ok: false,
      reason: 'throttled',
      kind: 'client',
    });
    expect((await signIns())[0]).toMatchObject({
      actorId: null,
      target: 'ada@example.com',
      outcome: 'denied',
      error: 'too many failed sign-in attempts',
      note: 'throttled per client; the password was not checked',
    });
  });

  it('logs loudly instead of blocking sign-in when the row cannot be written', async () => {
    const { database, owner } = await withOwner();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await database.close();
    open.splice(0);
    await expect(recordSignOut(database, ORG, owner)).resolves.toBeUndefined();
    expect(String(logged.mock.calls[0][0])).toContain('FAILED to record success auth.sign_out');
    logged.mockRestore();
  });
});

describe('attemptedEmail', () => {
  it('keeps something shaped like an address, normalised, and nothing else', () => {
    expect(attemptedEmail(' Ada@Example.com ')).toBe('ada@example.com');
    expect(attemptedEmail('hunter2')).toBe('[not an email address]');
    expect(attemptedEmail('two words@example.com')).toBe('[not an email address]');
  });
});
