import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { KeyMetadataFields } from '@/lib/keys/metadata';
import { auditValues, type AuditActor, type AuditRecord } from './audit';
import type { JsonValue } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * The dashboard's key inventory (ADR-0009 §7): label, owner and notes per key
 * hash, per environment, because g2way lists hashes only. Never the raw key.
 *
 * Every change writes its audit row (ADR-0006) in the same transaction, so an
 * inventory change and its record cannot come apart. None of these calls the
 * gateway, so none needs a reload or counts as staged (`pending.ts`).
 *
 * Every function takes the org explicitly (`getOrgId()` at the call site).
 */

export type KeyMetadata = typeof sqliteSchema.keyMetadata.$inferSelect;

export const KEY_METADATA_ACTIONS = {
  update: 'key.metadata.update',
  delete: 'key.metadata.delete',
  rekey: 'key.metadata.rekey',
} as const;

type KeyRef = { environment: string; keyHash: string };

/** The audit snapshot of a row: what a person would want back. */
export function metadataSnapshot(keyHash: string, fields: KeyMetadataFields): JsonValue {
  return { key_hash: keyHash, label: fields.label, owner: fields.owner, notes: fields.notes };
}

function fieldsOf(row: KeyMetadata): KeyMetadataFields {
  return { label: row.label, owner: row.owner, notes: row.notes };
}

type PgTable = Extract<DataHandle, { dialect: 'postgres' }>['schema']['keyMetadata'];

function matches(
  t: typeof sqliteSchema.keyMetadata | PgTable,
  orgId: string,
  { environment, keyHash }: KeyRef,
) {
  return and(eq(t.orgId, orgId), eq(t.environment, environment), eq(t.keyHash, keyHash));
}

/** One key's metadata, or `undefined` when none was ever written. */
export async function getKeyMetadata(
  handle: DataHandle,
  orgId: string,
  ref: KeyRef,
): Promise<KeyMetadata | undefined> {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.keyMetadata;
    return handle.db
      .select()
      .from(t)
      .where(matches(t, orgId, ref))
      .get();
  }
  const t = handle.schema.keyMetadata;
  const [row] = await handle.db
    .select()
    .from(t)
    .where(matches(t, orgId, ref));
  return row;
}

/** Keeps each `IN (...)` well under every driver's parameter limit. */
const CHUNK = 500;

/** The metadata of those `hashes` that have any, by hash (one list page's worth, typically). */
export async function listKeyMetadata(
  handle: DataHandle,
  orgId: string,
  environment: string,
  hashes: readonly string[],
): Promise<Map<string, KeyMetadata>> {
  const out = new Map<string, KeyMetadata>();
  const unique = [...new Set(hashes)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    let rows: KeyMetadata[];
    if (handle.dialect === 'sqlite') {
      const t = handle.schema.keyMetadata;
      rows = handle.db
        .select()
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.environment, environment), inArray(t.keyHash, chunk)))
        .all();
    } else {
      const t = handle.schema.keyMetadata;
      rows = await handle.db
        .select()
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.environment, environment), inArray(t.keyHash, chunk)));
    }
    for (const row of rows) out.set(row.keyHash, row);
  }
  return out;
}

/**
 * Every metadata row of `environment`, oldest first: orphan detection compares
 * them with the hashes the gateway lists (`lib/keys/orphans.ts`).
 */
export async function listAllKeyMetadata(
  handle: DataHandle,
  orgId: string,
  environment: string,
): Promise<KeyMetadata[]> {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.keyMetadata;
    return handle.db
      .select()
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.environment, environment)))
      .orderBy(asc(t.createdAt), asc(t.keyHash))
      .all();
  }
  const t = handle.schema.keyMetadata;
  return handle.db
    .select()
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.environment, environment)))
    .orderBy(asc(t.createdAt), asc(t.keyHash));
}

export type MetadataChange = { before: KeyMetadata | null; after: KeyMetadata | null };

/**
 * Sets a key's label, owner and notes (creating the row on first write),
 * audited as `key.metadata.update` with before and after. The caller has
 * already checked `keys:write` and that the key exists in the gateway.
 */
export async function upsertKeyMetadata(
  handle: DataHandle,
  orgId: string,
  change: KeyRef & { fields: KeyMetadataFields; actor: AuditActor },
): Promise<MetadataChange & { after: KeyMetadata }> {
  const { environment, keyHash, fields, actor } = change;
  const audit = (before: KeyMetadata | undefined): AuditRecord => ({
    actor,
    action: KEY_METADATA_ACTIONS.update,
    target: keyHash,
    environment,
    before: before === undefined ? null : metadataSnapshot(keyHash, fieldsOf(before)),
    after: metadataSnapshot(keyHash, fields),
    request: metadataSnapshot(keyHash, fields),
    outcome: 'success',
    notes: ['dashboard key inventory only: no gateway call, no reload needed'],
  });
  const insert = { orgId, environment, keyHash, ...fields, createdBy: actor.email };
  const set = { ...fields, updatedAt: new Date() };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.keyMetadata;
    return db.transaction(
      (tx) => {
        const before = tx
          .select()
          .from(t)
          .where(matches(t, orgId, change))
          .get();
        const after = tx
          .insert(t)
          .values(insert)
          .onConflictDoUpdate({ target: [t.orgId, t.environment, t.keyHash], set })
          .returning()
          .get();
        tx.insert(schema.auditLog)
          .values(auditValues(orgId, audit(before)))
          .run();
        return { before: before ?? null, after };
      },
      { behavior: 'immediate' },
    );
  }
  const { db, schema } = handle;
  const t = schema.keyMetadata;
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(t)
      .where(matches(t, orgId, change))
      .for('update');
    const [after] = await tx
      .insert(t)
      .values(insert)
      .onConflictDoUpdate({ target: [t.orgId, t.environment, t.keyHash], set })
      .returning();
    await tx.insert(schema.auditLog).values(auditValues(orgId, audit(before)));
    return { before: before ?? null, after };
  });
}

/**
 * Removes a key's metadata once the key itself is gone (a hard delete),
 * audited as `key.metadata.delete` with the removed row as `before`, so the
 * inventory of a deleted key stays readable in the audit log. No row, no-op.
 */
export async function deleteKeyMetadata(
  handle: DataHandle,
  orgId: string,
  change: KeyRef & { actor: AuditActor; note?: string },
): Promise<KeyMetadata | null> {
  const { environment, keyHash, actor } = change;
  const audit = (removed: KeyMetadata): AuditRecord => ({
    actor,
    action: KEY_METADATA_ACTIONS.delete,
    target: keyHash,
    environment,
    before: metadataSnapshot(keyHash, fieldsOf(removed)),
    after: null,
    outcome: 'success',
    notes: change.note === undefined ? [] : [change.note],
  });

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.keyMetadata;
    return db.transaction(
      (tx) => {
        const removed = tx
          .delete(t)
          .where(matches(t, orgId, change))
          .returning()
          .get();
        if (removed === undefined) return null;
        tx.insert(schema.auditLog)
          .values(auditValues(orgId, audit(removed)))
          .run();
        return removed;
      },
      { behavior: 'immediate' },
    );
  }
  const { db, schema } = handle;
  const t = schema.keyMetadata;
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(t)
      .where(matches(t, orgId, change))
      .returning();
    if (removed === undefined) return null;
    await tx.insert(schema.auditLog).values(auditValues(orgId, audit(removed)));
    return removed;
  });
}

/**
 * Carries a key's metadata from hash `from` to hash `to` (a rotation), audited
 * as `key.metadata.rekey`. `keepSource` copies instead of moving: the rotate
 * orchestration copies before it deletes the old key, and that delete removes
 * the old row, so a completed rotation is a move and a partial one (both keys
 * still exist) leaves both described. Whatever `to` held is replaced; the
 * original `created_by` and `created_at` travel with it. No source row, no-op.
 */
export async function rekeyKeyMetadata(
  handle: DataHandle,
  orgId: string,
  change: {
    environment: string;
    from: string;
    to: string;
    actor: AuditActor;
    keepSource: boolean;
  },
): Promise<KeyMetadata | null> {
  const { environment, from, to, actor, keepSource } = change;
  const source = { environment, keyHash: from };
  const target = { environment, keyHash: to };
  const audit = (row: KeyMetadata): AuditRecord => ({
    actor,
    action: KEY_METADATA_ACTIONS.rekey,
    target: to,
    environment,
    before: metadataSnapshot(from, fieldsOf(row)),
    after: metadataSnapshot(to, fieldsOf(row)),
    outcome: 'success',
    notes: [
      keepSource
        ? `copied from ${from} (key rotation; the old key's row goes when that key is deleted)`
        : `moved from ${from}`,
    ],
  });
  const values = (row: KeyMetadata) => ({
    orgId,
    environment,
    keyHash: to,
    ...fieldsOf(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  });

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.keyMetadata;
    return db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(t)
          .where(matches(t, orgId, source))
          .get();
        if (row === undefined) return null;
        tx.delete(t)
          .where(matches(t, orgId, target))
          .run();
        if (!keepSource)
          tx.delete(t)
            .where(matches(t, orgId, source))
            .run();
        const moved = tx.insert(t).values(values(row)).returning().get();
        tx.insert(schema.auditLog)
          .values(auditValues(orgId, audit(row)))
          .run();
        return moved;
      },
      { behavior: 'immediate' },
    );
  }
  const { db, schema } = handle;
  const t = schema.keyMetadata;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(t)
      .where(matches(t, orgId, source))
      .for('update');
    if (row === undefined) return null;
    await tx.delete(t).where(matches(t, orgId, target));
    if (!keepSource) await tx.delete(t).where(matches(t, orgId, source));
    const [moved] = await tx.insert(t).values(values(row)).returning();
    await tx.insert(schema.auditLog).values(auditValues(orgId, audit(row)));
    return moved;
  });
}
