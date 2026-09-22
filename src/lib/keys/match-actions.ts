'use server';

import { getCurrentUser } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import { getOrgId } from '@/lib/g2/environments';
import { resolveKeyMatches } from '@/lib/g2/key-matches';
import type { KeyMatchSelection } from './matches';

/**
 * "Select every match" on `/keys`: the full match set of `filter` in
 * `environmentId`, read now. A public endpoint like every server action, so
 * it re-checks the session here and `keys:write` in {@link resolveKeyMatches}.
 * Reads only; nothing is written or audited until the bulk action runs.
 */
export async function resolveKeyMatchesAction(
  environmentId: string,
  filter: unknown,
): Promise<KeyMatchSelection> {
  const actor = await getCurrentUser();
  if (actor === null) return { ok: false, error: 'Your session has ended. Sign in again.' };
  if (typeof environmentId !== 'string') return { ok: false, error: 'no environment named' };
  return resolveKeyMatches(actor, environmentId, filter, {
    labelsFor: (environment, hashes) =>
      listKeyMetadata(getDatabase(), getOrgId(), environment, hashes),
  });
}
