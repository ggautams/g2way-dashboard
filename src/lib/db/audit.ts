import 'server-only';

import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  lt,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { capSnapshot, redactSnapshot, snapshotKind } from '@/lib/audit/redact';
import type * as pgSchema from './schema/pg';
import type { AuditOutcome, JsonValue, Role } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * Data access for the audit log (ADR-0006), over ADR-0003's union like
 * `users.ts`. Every function takes the org explicitly (`getOrgId()` at the call
 * site, never a literal).
 *
 * Every snapshot is redacted here, on the way in (`@/lib/audit/redact`), so no
 * caller can store a secret by forgetting to. Writes that must be atomic with
 * the change they record (user management) build their row with
 * {@link auditValues} and insert it inside their own transaction.
 */

/** Who did it, snapshotted: the trail survives the account being deleted or re-roled. */
export type AuditActor = { id: string; email: string; role: Role };

/** The gateway call an action resulted in. `status` is unset while pending or when unreachable. */
export type GatewayCall = { method: string; path: string; status?: number | null };

export type AuditRecord = {
  /** `null` when nobody is signed in (a failed sign-in). */
  actor: AuditActor | null;
  /** `<resource>.<verb>`, e.g. `api.update`, `user.role_change`, `auth.sign_in`. */
  action: string;
  target?: string | null;
  /** State before the action; `null` when there was none (a creation) or it could not be read. */
  before?: JsonValue | null;
  /** State after the action; `null` for a deletion, a failure or a refusal. */
  after?: JsonValue | null;
  /** What was asked for: the request body or change, redacted like the snapshots. */
  request?: JsonValue | null;
  gateway?: GatewayCall | null;
  /** The gateway environment the call went to. */
  environment?: string | null;
  outcome: AuditOutcome;
  /** The refusal, or the gateway's own `{"error"}` message, verbatim. */
  error?: string | null;
  /** Caveats about the snapshots, joined with `; `. */
  notes?: readonly string[];
};

export type AuditEntry = typeof sqliteSchema.auditLog.$inferSelect;
type NewAuditRow = typeof sqliteSchema.auditLog.$inferInsert &
  typeof pgSchema.auditLog.$inferInsert;

const MAX_TEXT = 2000;
const clip = (text: string | null | undefined) =>
  text == null ? null : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

/**
 * The row for `record`: snapshots redacted (a secret that differs between
 * before and after shows as changed in `after`, never its value) and capped in
 * size, text clipped.
 */
export function auditValues(orgId: string, record: AuditRecord): NewAuditRow {
  const notes = [...(record.notes ?? [])];
  const cap = (label: string, value: JsonValue | null) => {
    const capped = capSnapshot(label, value);
    if (capped.note) notes.push(capped.note);
    return capped.value;
  };
  const kind = snapshotKind(record.action);
  const rawBefore = record.before ?? null;
  const before = cap('before', rawBefore === null ? null : redactSnapshot(rawBefore, null, kind));
  const after = cap(
    'after',
    record.after == null ? null : redactSnapshot(record.after, rawBefore, kind),
  );
  const request = cap(
    'request',
    record.request == null ? null : redactSnapshot(record.request, null, kind),
  );
  return {
    orgId,
    actorId: record.actor?.id ?? null,
    actorEmail: record.actor?.email ?? null,
    actorRole: record.actor?.role ?? null,
    action: record.action,
    target: clip(record.target),
    before,
    after,
    request,
    gatewayMethod: record.gateway?.method ?? null,
    gatewayPath: clip(record.gateway?.path),
    gatewayStatus: record.gateway?.status ?? null,
    environment: record.environment ?? null,
    outcome: record.outcome,
    error: clip(record.error),
    note: notes.length > 0 ? clip(notes.join('; ')) : null,
  };
}

/** Writes one audit row and returns its id. Throws if the database refuses. */
export async function recordAudit(
  handle: DataHandle,
  orgId: string,
  record: AuditRecord,
): Promise<string> {
  const values = auditValues(orgId, record);
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    return db.insert(schema.auditLog).values(values).returning({ id: schema.auditLog.id }).get().id;
  }
  const { db, schema } = handle;
  const [row] = await db
    .insert(schema.auditLog)
    .values(values)
    .returning({ id: schema.auditLog.id });
  return row.id;
}

/**
 * Completes a `pending` row once the gateway has answered: the whole record is
 * rewritten from `record` (pass the same actor, before and request), so
 * redaction compares the final `after` with the raw `before`.
 */
export async function completeAudit(
  handle: DataHandle,
  orgId: string,
  id: string,
  record: AuditRecord,
): Promise<void> {
  const values = auditValues(orgId, record);
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.auditLog;
    db.update(t)
      .set(values)
      .where(and(eq(t.orgId, orgId), eq(t.id, id)))
      .run();
    return;
  }
  const { db, schema } = handle;
  const t = schema.auditLog;
  await db
    .update(t)
    .set(values)
    .where(and(eq(t.orgId, orgId), eq(t.id, id)));
}

export type AuditFilter = {
  /** Substring of the actor's email. */
  actor?: string;
  /** An action, or a prefix of one (`api.` matches every API action). */
  action?: string;
  /** Substring of the target. */
  target?: string;
  outcome?: AuditOutcome;
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
};

/** A list row: everything but the snapshots, which only the detail view loads. */
export type AuditListItem = Omit<AuditEntry, 'before' | 'after' | 'request'>;

export type AuditPage = { entries: AuditListItem[]; hasMore: boolean };

/** `%` and `_` in user input match literally. */
function likePattern(text: string, { prefix }: { prefix: boolean }): string {
  const escaped = text.replace(/[\\%_]/g, (c) => `\\${c}`);
  return prefix ? `${escaped}%` : `%${escaped}%`;
}

type AuditTable = typeof sqliteSchema.auditLog | typeof pgSchema.auditLog;

function whereClause(
  t: AuditTable,
  dialect: DataHandle['dialect'],
  orgId: string,
  filter: AuditFilter,
): SQL | undefined {
  // SQLite's LIKE is case-insensitive for ASCII; Postgres needs ILIKE.
  const like = (column: AnyColumn, pattern: string) =>
    dialect === 'sqlite'
      ? sql`${column} like ${pattern} escape '\\'`
      : sql`${column} ilike ${pattern} escape '\\'`;
  const conditions: (SQL | undefined)[] = [eq(t.orgId, orgId)];
  if (filter.actor)
    conditions.push(like(t.actorEmail, likePattern(filter.actor, { prefix: false })));
  if (filter.action) conditions.push(like(t.action, likePattern(filter.action, { prefix: true })));
  if (filter.target) conditions.push(like(t.target, likePattern(filter.target, { prefix: false })));
  if (filter.outcome) conditions.push(eq(t.outcome, filter.outcome));
  if (filter.from) conditions.push(gte(t.createdAt, filter.from));
  if (filter.to) conditions.push(lt(t.createdAt, filter.to));
  return and(...conditions);
}

/** A table's columns minus the snapshots: the list view never loads them. */
function withoutSnapshots<T extends { before: unknown; after: unknown; request: unknown }>(
  columns: T,
): Omit<T, 'before' | 'after' | 'request'> {
  const rest: Partial<T> = { ...columns };
  delete rest.before;
  delete rest.after;
  delete rest.request;
  return rest as Omit<T, 'before' | 'after' | 'request'>;
}

/** Newest first, `limit` per page (1–200), skipping `offset`. */
export async function listAudit(
  handle: DataHandle,
  orgId: string,
  filter: AuditFilter = {},
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<AuditPage> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const skip = Math.max(Math.trunc(offset), 0);
  let rows: AuditListItem[];
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.auditLog;
    const listColumns = withoutSnapshots(getTableColumns(t));
    rows = db
      .select(listColumns)
      .from(t)
      .where(whereClause(t, 'sqlite', orgId, filter))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(take + 1)
      .offset(skip)
      .all();
  } else {
    const { db, schema } = handle;
    const t = schema.auditLog;
    const listColumns = withoutSnapshots(getTableColumns(t));
    rows = await db
      .select(listColumns)
      .from(t)
      .where(whereClause(t, 'postgres', orgId, filter))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(take + 1)
      .offset(skip);
  }
  return { entries: rows.slice(0, take), hasMore: rows.length > take };
}

/** One entry with its snapshots, or `undefined` if the org has no such row. */
export async function getAuditEntry(
  handle: DataHandle,
  orgId: string,
  id: string,
): Promise<AuditEntry | undefined> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.auditLog;
    return db
      .select()
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.id, id)))
      .get();
  }
  const { db, schema } = handle;
  const t = schema.auditLog;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.id, id)));
  return row;
}
