import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import type { AuditActor } from './audit';
import type { ConfigKind, JsonValue, VersionAction } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * Config history (ADR-0008): every version of an API definition or policy
 * written through the dashboard, per environment, unredacted so that a
 * rollback restores it exactly. Written by the BFF after the gateway accepts a
 * write; read by the designer's history tab.
 */

export type ConfigVersion = typeof sqliteSchema.configVersions.$inferSelect;

export type VersionWrite = {
  environment: string;
  kind: ConfigKind;
  resourceId: string;
  action: Exclude<VersionAction, 'baseline'>;
  /** The resource as the gateway held it before the write, if it existed. */
  before: JsonValue | null;
  /** As it holds it after; `null` for a delete. */
  after: JsonValue | null;
  actor: AuditActor;
  auditId: string;
};

type Where = { orgId: string; environment: string; kind: ConfigKind; resourceId: string };

function rows(write: VersionWrite, orgId: string, hasHistory: boolean) {
  const common = {
    orgId,
    environment: write.environment,
    kind: write.kind,
    resourceId: write.resourceId,
  };
  const out = [];
  // The first write through the dashboard to something made elsewhere keeps
  // what it replaced, so that change can be undone too.
  if (!hasHistory && write.before !== null) {
    out.push({ ...common, action: 'baseline' as const, definition: write.before });
  }
  out.push({
    ...common,
    action: write.action,
    definition: write.after,
    actorId: write.actor.id,
    actorEmail: write.actor.email,
    auditId: write.auditId,
  });
  return out;
}

/** Records the version a successful write produced (and a baseline before the first). */
export async function recordVersion(
  handle: DataHandle,
  orgId: string,
  write: VersionWrite,
): Promise<void> {
  const key: Where = { orgId, ...write };
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.configVersions;
    db.transaction((tx) => {
      const existing = tx.select({ id: t.id }).from(t).where(matches(t, key)).limit(1).get();
      tx.insert(t)
        .values(rows(write, orgId, existing !== undefined))
        .run();
    });
    return;
  }
  const { db, schema } = handle;
  const t = schema.configVersions;
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: t.id }).from(t).where(matches(t, key)).limit(1);
    await tx.insert(t).values(rows(write, orgId, existing.length > 0));
  });
}

function matches(
  t: typeof sqliteSchema.configVersions | DataHandleTable,
  { orgId, environment, kind, resourceId }: Where,
) {
  return and(
    eq(t.orgId, orgId),
    eq(t.environment, environment),
    eq(t.kind, kind),
    eq(t.resourceId, resourceId),
  );
}

type DataHandleTable = Extract<DataHandle, { dialect: 'postgres' }>['schema']['configVersions'];

/** A resource's versions, newest first, at most `limit` (1–200). */
export async function listVersions(
  handle: DataHandle,
  orgId: string,
  resource: Omit<Where, 'orgId'>,
  limit = 50,
): Promise<ConfigVersion[]> {
  const where = { orgId, ...resource };
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.configVersions;
    return db
      .select()
      .from(t)
      .where(matches(t, where))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(take)
      .all();
  }
  const { db, schema } = handle;
  const t = schema.configVersions;
  return db
    .select()
    .from(t)
    .where(matches(t, where))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(take);
}
