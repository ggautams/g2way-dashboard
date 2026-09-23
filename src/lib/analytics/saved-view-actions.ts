'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getOrgId } from '@/lib/g2/environments';
import { deleteView, saveView } from './saved-view-service';
import type { SavedViewFormState } from './saved-views';

/**
 * The saved-view server actions (ADR-0016). Public endpoints like every
 * server action, so each re-checks the session here and the permissions in
 * `saved-view-service.ts`. The page passes them to client components as
 * props, so those import nothing server-side.
 */

const SIGNED_OUT: SavedViewFormState = { error: 'Your session has ended. Sign in again.' };

export async function saveViewAction(
  _previous: SavedViewFormState,
  formData: FormData,
): Promise<SavedViewFormState> {
  const actor = await getCurrentUser();
  if (actor === null) return SIGNED_OUT;
  const state = await saveView(actor, formData, { handle: getDatabase(), orgId: getOrgId() });
  if (state.error === null) revalidatePath('/analytics');
  return state;
}

export async function deleteViewAction(
  _previous: SavedViewFormState,
  formData: FormData,
): Promise<SavedViewFormState> {
  const actor = await getCurrentUser();
  if (actor === null) return SIGNED_OUT;
  const state = await deleteView(actor, formData, { handle: getDatabase(), orgId: getOrgId() });
  if (state.error === null) revalidatePath('/analytics');
  return state;
}
