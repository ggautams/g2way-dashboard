import { PGlite } from '@electric-sql/pglite';
import { asc } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VIEWS_PER_OWNER } from '@/lib/analytics/saved-views';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import { createSavedView, deleteSavedView, listSavedViews } from './saved-views';
import * as pgSchema from './schema/pg';
import type { DataHandle } from './users';

// Stand-in orgs: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const OTHER_ORG = 'org-other';

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

async function auditRows(handle: DataHandle) {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.auditLog;
    return handle.db.select().from(t).orderBy(asc(t.createdAt), asc(t.id)).all();
  }
  const t = handle.schema.auditLog;
  return handle.db.select().from(t).orderBy(asc(t.createdAt), asc(t.id));
}

const ada = { id: 'u-ada', email: 'ada@example.com', role: 'editor' as const };
const bob = { id: 'u-bob', email: 'bob@example.com', role: 'viewer' as const };
const view = (name: string, shared = false, environment = 'prod') => ({
  environment,
  name,
  shared,
  query: 'range=24h&by=api',
});

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('saved views on %s', (_name, open) => {
  it('lists shared views for everyone, personal ones for their owner, per org and environment', async () => {
    const handle = await open();
    await createSavedView(handle, ORG, { ...view('Team 5xx', true), actor: ada });
    await createSavedView(handle, ORG, { ...view('Ada only'), actor: ada });
    await createSavedView(handle, ORG, { ...view('Bob only'), actor: bob });
    await createSavedView(handle, ORG, { ...view('Staging', true, 'staging'), actor: ada });
    await createSavedView(handle, OTHER_ORG, { ...view('Elsewhere', true), actor: ada });

    const names = async (ownerId: string) =>
      (await listSavedViews(handle, ORG, { environment: 'prod', ownerId })).map((v) => v.name);
    expect(await names(ada.id)).toEqual(['Team 5xx', 'Ada only']);
    expect(await names(bob.id)).toEqual(['Team 5xx', 'Bob only']);
  });

  it('audits a creation in the same write, and refuses a clashing name', async () => {
    const handle = await open();
    const created = await createSavedView(handle, ORG, { ...view('Mine'), actor: ada });
    expect(created).toMatchObject({ ok: true, view: { name: 'Mine', ownerEmail: ada.email } });
    expect(await createSavedView(handle, ORG, { ...view('Mine', true), actor: ada })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    // Another owner, or another environment, may reuse the name.
    expect((await createSavedView(handle, ORG, { ...view('Mine'), actor: bob })).ok).toBe(true);
    expect(
      (await createSavedView(handle, ORG, { ...view('Mine', false, 'dev'), actor: ada })).ok,
    ).toBe(true);

    const [row] = await auditRows(handle);
    expect(row).toMatchObject({
      orgId: ORG,
      action: 'analytics.view.create',
      actorEmail: ada.email,
      environment: 'prod',
      outcome: 'success',
      before: null,
      after: { name: 'Mine', shared: false, query: 'range=24h&by=api', owner: ada.email },
    });
    expect(row.target).toBe(created.ok ? created.view.id : null);
  });

  it('caps each owner’s views per environment', async () => {
    const handle = await open();
    for (let i = 0; i < MAX_VIEWS_PER_OWNER; i++) {
      expect((await createSavedView(handle, ORG, { ...view(`v${i}`), actor: ada })).ok).toBe(true);
    }
    expect(await createSavedView(handle, ORG, { ...view('one more'), actor: ada })).toEqual({
      ok: false,
      reason: 'limit',
    });
    expect((await createSavedView(handle, ORG, { ...view('one more'), actor: bob })).ok).toBe(true);
  });

  it('deletes a personal view only for its owner, a shared one only with the permission', async () => {
    const handle = await open();
    const mine = await createSavedView(handle, ORG, { ...view('Ada only'), actor: ada });
    const team = await createSavedView(handle, ORG, { ...view('Team', true), actor: ada });
    if (!mine.ok || !team.ok) throw new Error('seed failed');
    const del = (id: string, actor: typeof ada | typeof bob, mayDeleteShared = false) =>
      deleteSavedView(handle, ORG, { environment: 'prod', id, actor, mayDeleteShared });

    expect(await del(mine.view.id, bob, true)).toEqual({ ok: false, reason: 'not-yours' });
    expect(await del(team.view.id, bob)).toEqual({ ok: false, reason: 'needs-share' });
    expect(await del('no-such-id', ada)).toEqual({ ok: false, reason: 'not-found' });
    // The right id in the wrong org or environment is not found either.
    expect(
      await deleteSavedView(handle, OTHER_ORG, {
        environment: 'prod',
        id: mine.view.id,
        actor: ada,
        mayDeleteShared: true,
      }),
    ).toEqual({ ok: false, reason: 'not-found' });

    expect(await del(team.view.id, bob, true)).toMatchObject({ ok: true, view: { name: 'Team' } });
    expect(await del(mine.view.id, ada)).toMatchObject({ ok: true, view: { name: 'Ada only' } });
    expect(await listSavedViews(handle, ORG, { environment: 'prod', ownerId: ada.id })).toEqual([]);

    const deletes = (await auditRows(handle)).filter((r) => r.action === 'analytics.view.delete');
    expect(deletes.map((r) => [r.actorEmail, r.before, r.after])).toEqual([
      [
        bob.email,
        { name: 'Team', shared: true, query: 'range=24h&by=api', owner: ada.email },
        null,
      ],
      [
        ada.email,
        { name: 'Ada only', shared: false, query: 'range=24h&by=api', owner: ada.email },
        null,
      ],
    ]);
  });
});
