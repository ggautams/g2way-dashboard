import { PGlite } from '@electric-sql/pglite';
import { asc } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import {
  deleteKeyMetadata,
  getKeyMetadata,
  listKeyMetadata,
  rekeyKeyMetadata,
  upsertKeyMetadata,
} from './key-metadata';
import { STAGED_ACTIONS } from './pending';
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

async function auditRows(handle: DataHandle) {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.auditLog;
    return handle.db.select().from(t).orderBy(asc(t.createdAt), asc(t.id)).all();
  }
  const t = handle.schema.auditLog;
  return handle.db.select().from(t).orderBy(asc(t.createdAt), asc(t.id));
}

const actor = { id: 'u1', email: 'ada@example.com', role: 'editor' as const };
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const fields = { label: 'Checkout service', owner: 'payments team', notes: 'rotate quarterly' };

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('key metadata on %s', (_name, open) => {
  const ref = (keyHash = OLD, environment = 'prod') => ({ environment, keyHash });

  it('creates, then updates, auditing both with before and after', async () => {
    const handle = await open();
    const first = await upsertKeyMetadata(handle, ORG, { ...ref(), fields, actor });
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ ...fields, keyHash: OLD, createdBy: actor.email });

    const second = await upsertKeyMetadata(handle, ORG, {
      ...ref(),
      fields: { ...fields, owner: null },
      actor: { ...actor, email: 'bob@example.com' },
    });
    expect(second.before?.owner).toBe('payments team');
    expect(second.after.owner).toBeNull();
    // The first writer stays the creator.
    expect(second.after.createdBy).toBe(actor.email);
    expect(second.after.id).toBe(first.after.id);

    const audit = await auditRows(handle);
    expect(audit.map((row) => [row.action, row.target, row.environment, row.outcome])).toEqual([
      ['key.metadata.update', OLD, 'prod', 'success'],
      ['key.metadata.update', OLD, 'prod', 'success'],
    ]);
    expect(audit[0].before).toBeNull();
    expect(audit[1].before).toMatchObject({ key_hash: OLD, owner: 'payments team' });
    expect(audit[1].after).toMatchObject({ key_hash: OLD, owner: null });
    expect(audit[1].gatewayMethod).toBeNull();
  });

  it('is never a staged change: no reload involved', () => {
    for (const action of ['key.metadata.update', 'key.metadata.delete', 'key.metadata.rekey']) {
      expect(STAGED_ACTIONS).not.toContain(action);
    }
  });

  it('lists only the asked-for hashes, per environment and org', async () => {
    const handle = await open();
    await upsertKeyMetadata(handle, ORG, { ...ref(OLD), fields, actor });
    await upsertKeyMetadata(handle, ORG, { ...ref(NEW, 'dev'), fields, actor });
    const listed = await listKeyMetadata(handle, ORG, 'prod', [OLD, NEW, OLD]);
    expect([...listed.keys()]).toEqual([OLD]);
    expect(await listKeyMetadata(handle, ORG, 'prod', [])).toEqual(new Map());
    expect((await listKeyMetadata(handle, 'another-org', 'prod', [OLD])).size).toBe(0);
    expect(await getKeyMetadata(handle, 'another-org', ref())).toBeUndefined();
    expect(await getKeyMetadata(handle, ORG, ref(OLD, 'dev'))).toBeUndefined();
  });

  it('deletes with an audit row keeping what was removed; deleting nothing is silent', async () => {
    const handle = await open();
    await upsertKeyMetadata(handle, ORG, { ...ref(), fields, actor });
    expect(await deleteKeyMetadata(handle, 'another-org', { ...ref(), actor })).toBeNull();
    const removed = await deleteKeyMetadata(handle, ORG, { ...ref(), actor, note: 'key deleted' });
    expect(removed?.label).toBe(fields.label);
    expect(await getKeyMetadata(handle, ORG, ref())).toBeUndefined();
    expect(await deleteKeyMetadata(handle, ORG, { ...ref(), actor })).toBeNull();
    const audit = await auditRows(handle);
    expect(audit.map((row) => row.action)).toEqual(['key.metadata.update', 'key.metadata.delete']);
    expect(audit[1].before).toMatchObject({ key_hash: OLD, label: fields.label });
    expect(audit[1].note).toBe('key deleted');
  });

  it('moves to a new hash on rotate, keeping the creator', async () => {
    const handle = await open();
    await upsertKeyMetadata(handle, ORG, { ...ref(), fields, actor });
    const other = { ...actor, email: 'bob@example.com' };
    const moved = await rekeyKeyMetadata(handle, ORG, {
      environment: 'prod',
      from: OLD,
      to: NEW,
      actor: other,
      keepSource: false,
    });
    expect(moved).toMatchObject({ ...fields, keyHash: NEW, createdBy: actor.email });
    expect(await getKeyMetadata(handle, ORG, ref(OLD))).toBeUndefined();
    const audit = await auditRows(handle);
    expect(audit.at(-1)).toMatchObject({
      action: 'key.metadata.rekey',
      target: NEW,
      actorEmail: other.email,
      before: { key_hash: OLD },
      after: { key_hash: NEW },
    });
  });

  it('copies on a partial rotation, replacing whatever the new hash held', async () => {
    const handle = await open();
    await upsertKeyMetadata(handle, ORG, { ...ref(OLD), fields, actor });
    await upsertKeyMetadata(handle, ORG, { ...ref(NEW), fields: { ...fields, label: 'x' }, actor });
    await rekeyKeyMetadata(handle, ORG, {
      environment: 'prod',
      from: OLD,
      to: NEW,
      actor,
      keepSource: true,
    });
    const both = await listKeyMetadata(handle, ORG, 'prod', [OLD, NEW]);
    expect(both.get(OLD)?.label).toBe(fields.label);
    expect(both.get(NEW)?.label).toBe(fields.label);
  });

  it('re-keys nothing when the old hash has no metadata', async () => {
    const handle = await open();
    const args = { environment: 'prod', from: OLD, to: NEW, actor, keepSource: false };
    expect(await rekeyKeyMetadata(handle, ORG, args)).toBeNull();
    expect(await auditRows(handle)).toEqual([]);
  });
});
