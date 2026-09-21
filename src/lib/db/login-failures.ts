import 'server-only';

import { and, count, eq, gte, lt } from 'drizzle-orm';
import type { ThrottleKind } from './schema/shared';
import type { DataHandle } from './users';

/**
 * Data access for failed sign-ins, the counts behind sign-in throttling
 * (`src/lib/auth/throttle.ts`, which owns the policy). Every function takes the
 * org explicitly, from config.
 */

export type ThrottleKey = { kind: ThrottleKind; key: string };

/** How many failures were recorded against one key since a moment. */
export async function countFailures(
  handle: DataHandle,
  orgId: string,
  { kind, key }: ThrottleKey,
  since: Date,
): Promise<number> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.loginFailures;
    const row = db
      .select({ failures: count() })
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.kind, kind), eq(t.key, key), gte(t.createdAt, since)))
      .get();
    return row?.failures ?? 0;
  }
  const { db, schema } = handle;
  const t = schema.loginFailures;
  const [row] = await db
    .select({ failures: count() })
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.kind, kind), eq(t.key, key), gte(t.createdAt, since)));
  return row?.failures ?? 0;
}

/**
 * Records one failure against each key, and prunes this org's rows older than
 * `pruneBefore`, which no window can count any more.
 */
export async function recordFailures(
  handle: DataHandle,
  orgId: string,
  keys: readonly ThrottleKey[],
  now: Date,
  pruneBefore: Date,
): Promise<void> {
  const rows = keys.map(({ kind, key }) => ({ orgId, kind, key, createdAt: now }));
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.loginFailures;
    db.transaction((tx) => {
      tx.delete(t)
        .where(and(eq(t.orgId, orgId), lt(t.createdAt, pruneBefore)))
        .run();
      if (rows.length > 0) tx.insert(t).values(rows).run();
    });
    return;
  }
  const { db, schema } = handle;
  const t = schema.loginFailures;
  await db.transaction(async (tx) => {
    await tx.delete(t).where(and(eq(t.orgId, orgId), lt(t.createdAt, pruneBefore)));
    if (rows.length > 0) await tx.insert(t).values(rows);
  });
}

/** Forgets every failure recorded against one key. */
export async function clearFailures(
  handle: DataHandle,
  orgId: string,
  { kind, key }: ThrottleKey,
): Promise<void> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.loginFailures;
    db.delete(t)
      .where(and(eq(t.orgId, orgId), eq(t.kind, kind), eq(t.key, key)))
      .run();
    return;
  }
  const { db, schema } = handle;
  const t = schema.loginFailures;
  await db.delete(t).where(and(eq(t.orgId, orgId), eq(t.kind, kind), eq(t.key, key)));
}
