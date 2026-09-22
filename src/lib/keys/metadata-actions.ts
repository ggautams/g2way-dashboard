'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getOrgId } from '@/lib/g2/environments';
import { saveKeyMetadata } from '@/lib/g2/key-metadata';
import type { KeyMetadataFormState } from './metadata';

/**
 * Saves a key's dashboard metadata (label, owner, notes; ADR-0009 §7). A
 * public endpoint like every server action, so it re-checks the session here
 * and `keys:write` in {@link saveKeyMetadata}. Pages pass it to client
 * components as a prop, so they import nothing server-side.
 */
export async function saveKeyMetadataAction(
  _previous: KeyMetadataFormState,
  formData: FormData,
): Promise<KeyMetadataFormState> {
  const actor = await getCurrentUser();
  if (actor === null) return { error: 'Your session has ended. Sign in again.' };
  const state = await saveKeyMetadata(actor, formData, {
    handle: getDatabase(),
    orgId: getOrgId(),
  });
  if (state.error === null) {
    revalidatePath('/keys');
    const hash = formData.get('hash');
    if (typeof hash === 'string') revalidatePath(`/keys/view/${encodeURIComponent(hash)}`);
  }
  return state;
}
