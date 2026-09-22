import 'server-only';

import { and, asc, desc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import type * as pgSchema from './schema/pg';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * Staged changes: API and policy writes that reached the gateway's storage but
 * not its data plane, which only changes on `POST /g2/reload`
 * (`docs/g2way-map.md`). Derived from the audit log (ADR-0006) rather than
 * kept separately: a pending change is a successful write to an environment
 * recorded after that environment's last successful reload. The audit log
 * already holds both, atomically with the calls, so there is no second record
 * to drift.
 *
 * Only reloads made through this dashboard are seen. A reload from the CLI or
 * another tool leaves the count stale until the next one here (the UI says so).
 */

/** Writes that need a reload to take effect. Key writes are live at once. */
export const STAGED_ACTIONS = [
  'api.create',
  'api.update',
  'api.delete',
  'policy.create',
  'policy.update',
  'policy.delete',
] as const;

export type PendingChange = {
  id: string;
  action: string;
  target: string | null;
  actorEmail: string | null;
  createdAt: Date;
};

export type PendingChanges = {
  changes: PendingChange[];
  /** When the environment last reloaded through the dashboard, if ever. */
  lastReloadAt: Date | null;
};

type AuditTable = typeof sqliteSchema.auditLog | typeof pgSchema.auditLog;

function stagedSince(
  t: AuditTable,
  orgId: string,
  environment: string,
  reload: { id: string; createdAt: Date } | undefined,
): SQL | undefined {
  return and(
    eq(t.orgId, orgId),
    eq(t.environment, environment),
    eq(t.outcome, 'success'),
    inArray(t.action, [...STAGED_ACTIONS]),
    // Strictly after the reload; ids break a same-millisecond tie (UUIDv7, ADR-0006).
    reload === undefined
      ? undefined
      : or(
          gt(t.createdAt, reload.createdAt),
          and(eq(t.createdAt, reload.createdAt), gt(t.id, reload.id)),
        ),
  );
}

function lastReload(t: AuditTable, orgId: string, environment: string): SQL | undefined {
  return and(
    eq(t.orgId, orgId),
    eq(t.environment, environment),
    eq(t.action, 'gateway.reload'),
    eq(t.outcome, 'success'),
  );
}

/** The staged changes for one environment of the org, oldest first. */
export async function listPendingChanges(
  handle: DataHandle,
  orgId: string,
  environment: string,
): Promise<PendingChanges> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.auditLog;
    const reload = db
      .select({ id: t.id, createdAt: t.createdAt })
      .from(t)
      .where(lastReload(t, orgId, environment))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1)
      .get();
    const changes = db
      .select({
        id: t.id,
        action: t.action,
        target: t.target,
        actorEmail: t.actorEmail,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(stagedSince(t, orgId, environment, reload))
      .orderBy(asc(t.createdAt), asc(t.id))
      .all();
    return { changes, lastReloadAt: reload?.createdAt ?? null };
  }
  const { db, schema } = handle;
  const t = schema.auditLog;
  const [reload] = await db
    .select({ id: t.id, createdAt: t.createdAt })
    .from(t)
    .where(lastReload(t, orgId, environment))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(1);
  const changes = await db
    .select({
      id: t.id,
      action: t.action,
      target: t.target,
      actorEmail: t.actorEmail,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(stagedSince(t, orgId, environment, reload))
    .orderBy(asc(t.createdAt), asc(t.id));
  return { changes, lastReloadAt: reload?.createdAt ?? null };
}
