'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getOrgId } from '@/lib/g2/environments';
import { pruneKeyOrphans } from '@/lib/g2/key-orphans';
import type { PruneOrphansState } from './orphans';

/**
 * Prunes orphaned key metadata (ADR-0009 §7). A public endpoint like every
 * server action, so it re-checks the session here and `keys:write` in
 * {@link pruneKeyOrphans}, which also re-reads the gateway's key list.
 */
export async function pruneKeyOrphansAction(
  _previous: PruneOrphansState,
  formData: FormData,
): Promise<PruneOrphansState> {
  const actor = await getCurrentUser();
  if (actor === null) return { error: 'Your session has ended. Sign in again.' };
  const state = await pruneKeyOrphans(actor, formData, {
    handle: getDatabase(),
    orgId: getOrgId(),
  });
  if (state.error === null) revalidatePath('/keys');
  return state;
}
