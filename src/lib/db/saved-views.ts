import 'server-only';

import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { MAX_VIEWS_PER_OWNER } from '@/lib/analytics/saved-views';
import { auditValues, type AuditActor, type AuditRecord } from './audit';
import type { JsonValue } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * Saved `/analytics` views (ADR-0016), per org and environment. A view is
 * personal (listed for its owner only) or shared (listed for everyone who may
 * open `/analytics`). Who may share or delete is the caller's check
 * (`src/lib/analytics/saved-view-service.ts`); these functions enforce what
 * the data can: the name clash, the per-owner cap, and that a personal view is
 * deleted only by its owner.
 *
 * Every write records its audit row in the same transaction (ADR-0006 §5).
 * No gateway call, nothing staged. Every function takes the org explicitly.
 */

export type SavedView = typeof sqliteSchema.savedViews.$inferSelect;

export const SAVED_VIEW_ACTIONS = {
  create: 'analytics.view.create',
  delete: 'analytics.view.delete',
} as const;

const NOTE = 'dashboard-only: a saved /analytics view, no gateway call';

/** The audit snapshot of a view. */
export function viewSnapshot(
  view: Pick<SavedView, 'name' | 'shared' | 'query' | 'ownerEmail'>,
): JsonValue {
  return { name: view.name, shared: view.shared, query: view.query, owner: view.ownerEmail };
}

/** The shared views of `environment`, then `ownerId`'s own; each group by name. */
export async function listSavedViews(
  handle: DataHandle,
  orgId: string,
  scope: { environment: string; ownerId: string },
): Promise<SavedView[]> {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.savedViews;
    return handle.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.environment, scope.environment),
          or(eq(t.shared, true), eq(t.ownerId, scope.ownerId)),
        ),
      )
      .orderBy(desc(t.shared), asc(t.name), asc(t.id))
      .all();
  }
  const t = handle.schema.savedViews;
  return handle.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.environment, scope.environment),
        or(eq(t.shared, true), eq(t.ownerId, scope.ownerId)),
      ),
    )
    .orderBy(desc(t.shared), asc(t.name), asc(t.id));
}

export type NewSavedView = {
  environment: string;
  name: string;
  shared: boolean;
  query: string;
  actor: AuditActor;
};

export type CreateViewResult =
  { ok: true; view: SavedView } | { ok: false; reason: 'duplicate' | 'limit' };

/**
 * Saves a view owned by `actor`, audited as `analytics.view.create`. Refused
 * (and nothing written) when the actor already has a view of that name in the
 * environment, or already keeps `MAX_VIEWS_PER_OWNER` there.
 */
export async function createSavedView(
  handle: DataHandle,
  orgId: string,
  input: NewSavedView,
): Promise<CreateViewResult> {
  const { environment, name, shared, query, actor } = input;
  const values = {
    orgId,
    environment,
    ownerId: actor.id,
    ownerEmail: actor.email,
    name,
    shared,
    query,
  };
  const audit = (view: SavedView): AuditRecord => ({
    actor,
    action: SAVED_VIEW_ACTIONS.create,
    target: view.id,
    environment,
    before: null,
    after: viewSnapshot(view),
    request: viewSnapshot(values),
    outcome: 'success',
    notes: [NOTE],
  });

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.savedViews;
    const mine = and(eq(t.orgId, orgId), eq(t.environment, environment), eq(t.ownerId, actor.id));
    return db.transaction(
      (tx): CreateViewResult => {
        const clash = tx
          .select({ id: t.id })
          .from(t)
          .where(and(mine, eq(t.name, name)))
          .get();
        if (clash !== undefined) return { ok: false, reason: 'duplicate' };
        const count = tx
          .select({ n: sql<number>`count(*)` })
          .from(t)
          .where(mine)
          .get();
        if (Number(count?.n ?? 0) >= MAX_VIEWS_PER_OWNER) return { ok: false, reason: 'limit' };
        const view = tx.insert(t).values(values).returning().get();
        tx.insert(schema.auditLog)
          .values(auditValues(orgId, audit(view)))
          .run();
        return { ok: true, view };
      },
      { behavior: 'immediate' },
    );
  }
  const { db, schema } = handle;
  const t = schema.savedViews;
  const mine = and(eq(t.orgId, orgId), eq(t.environment, environment), eq(t.ownerId, actor.id));
  return db.transaction(async (tx): Promise<CreateViewResult> => {
    // One owner's saves queue up, so two tabs cannot both pass the cap.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`g2dash:views:${orgId}:${environment}:${actor.id}`}))`,
    );
    const [clash] = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(mine, eq(t.name, name)));
    if (clash !== undefined) return { ok: false, reason: 'duplicate' };
    const [count] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(mine);
    if (Number(count?.n ?? 0) >= MAX_VIEWS_PER_OWNER) return { ok: false, reason: 'limit' };
    const [view] = await tx.insert(t).values(values).returning();
    await tx.insert(schema.auditLog).values(auditValues(orgId, audit(view)));
    return { ok: true, view };
  });
}

export type DeleteViewResult =
  { ok: true; view: SavedView } | { ok: false; reason: 'not-found' | 'not-yours' | 'needs-share' };

/**
 * Deletes view `id` of `environment`, audited as `analytics.view.delete`
 * with the removed view as `before`. A personal view only by its owner; a
 * shared one only when `mayDeleteShared` (the caller's `analytics:share`
 * check). Someone else's personal view reads as `not-yours` here; the
 * caller shows it as not found, so its existence is not revealed.
 */
export async function deleteSavedView(
  handle: DataHandle,
  orgId: string,
  input: { environment: string; id: string; actor: AuditActor; mayDeleteShared: boolean },
): Promise<DeleteViewResult> {
  const { environment, id, actor, mayDeleteShared } = input;
  const audit = (view: SavedView): AuditRecord => ({
    actor,
    action: SAVED_VIEW_ACTIONS.delete,
    target: view.id,
    environment,
    before: viewSnapshot(view),
    after: null,
    outcome: 'success',
    notes: [NOTE],
  });
  const refusal = (view: SavedView | undefined): DeleteViewResult | null => {
    if (view === undefined) return { ok: false, reason: 'not-found' };
    if (view.shared) return mayDeleteShared ? null : { ok: false, reason: 'needs-share' };
    return view.ownerId === actor.id ? null : { ok: false, reason: 'not-yours' };
  };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.savedViews;
    const match = and(eq(t.orgId, orgId), eq(t.environment, environment), eq(t.id, id));
    return db.transaction(
      (tx): DeleteViewResult => {
        const view = tx.select().from(t).where(match).get();
        const refused = refusal(view);
        if (refused !== null) return refused;
        if (view === undefined) throw new Error('unreachable: refusal() answers a missing view');
        tx.delete(t).where(match).run();
        tx.insert(schema.auditLog)
          .values(auditValues(orgId, audit(view)))
          .run();
        return { ok: true, view };
      },
      { behavior: 'immediate' },
    );
  }
  const { db, schema } = handle;
  const t = schema.savedViews;
  const match = and(eq(t.orgId, orgId), eq(t.environment, environment), eq(t.id, id));
  return db.transaction(async (tx): Promise<DeleteViewResult> => {
    const [view] = await tx.select().from(t).where(match).for('update');
    const refused = refusal(view);
    if (refused !== null) return refused;
    if (view === undefined) throw new Error('unreachable: refusal() answers a missing view');
    await tx.delete(t).where(match);
    await tx.insert(schema.auditLog).values(auditValues(orgId, audit(view)));
    return { ok: true, view };
  });
}
