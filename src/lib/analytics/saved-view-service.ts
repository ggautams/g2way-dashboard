import 'server-only';

import { can } from '@/lib/auth/rbac';
import { recordAudit, type AuditActor, type AuditRecord } from '@/lib/db/audit';
import { SAVED_VIEW_ACTIONS, createSavedView, deleteSavedView } from '@/lib/db/saved-views';
import type { DataHandle } from '@/lib/db/users';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  resolveEnvironment,
  type Registry,
} from '@/lib/g2/environments';
import { rollupRetention } from './load-health';
import {
  MAX_VIEWS_PER_OWNER,
  canonicalViewQuery,
  parseViewName,
  type SavedViewFormState,
} from './saved-views';

/**
 * Saving and deleting `/analytics` views from a submitted form (ADR-0016):
 * the permission checks, with refusals audited as `denied` best effort, and
 * the form's answer. The writes and their audit rows are
 * `src/lib/db/saved-views.ts`. Dashboard-only: no gateway call, no reload.
 */

export type SavedViewDeps = { handle: DataHandle; orgId: string; registry?: Registry };

const capitalise = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;

async function recordDenied(deps: SavedViewDeps, record: Omit<AuditRecord, 'outcome'>) {
  try {
    await recordAudit(deps.handle, deps.orgId, { ...record, outcome: 'denied' });
  } catch (error) {
    console.error(`[audit] FAILED to record denied ${record.action}:`, error);
  }
}

function environmentOf(
  form: FormData,
  deps: SavedViewDeps,
): { ok: true; id: string } | { ok: false; error: string } {
  const environment = form.get('environment');
  if (typeof environment !== 'string') {
    return { ok: false, error: 'The form is missing its environment.' };
  }
  try {
    return { ok: true, id: resolveEnvironment(environment, deps.registry).id };
  } catch (error) {
    if (error instanceof UnknownEnvironmentError || error instanceof RegistryConfigError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Saves the view in the form (`name`, `query`, `shared`, `environment`) for
 * `actor`. Needs `gateway:read`, and `analytics:share` to share.
 */
export async function saveView(
  actor: AuditActor,
  form: FormData,
  deps: SavedViewDeps,
): Promise<SavedViewFormState> {
  const shared = form.get('shared') === 'on';
  const permission = !can(actor.role, 'gateway:read')
    ? 'gateway:read'
    : shared && !can(actor.role, 'analytics:share')
      ? 'analytics:share'
      : null;
  const env = environmentOf(form, deps);
  if (permission !== null) {
    const message = `forbidden: the ${actor.role} role lacks the ${permission} permission (${shared ? 'shared' : 'saved'} analytics view)`;
    await recordDenied(deps, {
      actor,
      action: SAVED_VIEW_ACTIONS.create,
      environment: env.ok ? env.id : null,
      request: { name: String(form.get('name') ?? ''), shared },
      error: message,
    });
    return { error: `${capitalise(message)}.` };
  }
  if (!env.ok) return { error: env.error };

  const name = parseViewName(form.get('name'));
  if (!name.ok) return { error: `Not saved: ${name.error}.` };
  const rawQuery = form.get('query');
  const query = canonicalViewQuery(typeof rawQuery === 'string' ? rawQuery : '', {
    keys: can(actor.role, 'keys:read'),
    hourRetentionDays: rollupRetention().hourRetentionDays,
  });
  if (!query.ok) return { error: `Not saved: ${query.error}.` };

  try {
    const result = await createSavedView(deps.handle, deps.orgId, {
      environment: env.id,
      name: name.value,
      shared,
      query: query.query,
      actor,
    });
    if (!result.ok) {
      return {
        error:
          result.reason === 'duplicate'
            ? `Not saved: you already have a view named “${name.value}” here. Pick another name, or delete that one first.`
            : `Not saved: you already keep ${MAX_VIEWS_PER_OWNER} views in this environment. Delete one first.`,
      };
    }
  } catch (error) {
    console.error('[audit] FAILED to save an analytics view:', error);
    return { error: 'Not saved: the dashboard database refused the write (see the server log).' };
  }
  return {
    error: null,
    notice: shared
      ? `Saved “${name.value}” for everyone in this environment.`
      : `Saved “${name.value}”. Only you see it.`,
  };
}

/**
 * Deletes view `id` from the form for `actor`: their own personal view, or
 * any shared one with `analytics:share`. Someone else's personal view answers
 * as not found, and the attempt is audited as `denied`.
 */
export async function deleteView(
  actor: AuditActor,
  form: FormData,
  deps: SavedViewDeps,
): Promise<SavedViewFormState> {
  const id = form.get('id');
  if (typeof id !== 'string' || id === '') return { error: 'The form is missing the view.' };
  const env = environmentOf(form, deps);
  if (!can(actor.role, 'gateway:read')) {
    const message = `forbidden: the ${actor.role} role lacks the gateway:read permission (saved analytics view)`;
    await recordDenied(deps, {
      actor,
      action: SAVED_VIEW_ACTIONS.delete,
      target: id,
      environment: env.ok ? env.id : null,
      error: message,
    });
    return { error: `${capitalise(message)}.` };
  }
  if (!env.ok) return { error: env.error };

  let result;
  try {
    result = await deleteSavedView(deps.handle, deps.orgId, {
      environment: env.id,
      id,
      actor,
      mayDeleteShared: can(actor.role, 'analytics:share'),
    });
  } catch (error) {
    console.error('[audit] FAILED to delete an analytics view:', error);
    return { error: 'Not deleted: the dashboard database refused the write (see the server log).' };
  }
  if (result.ok) return { error: null, notice: `Deleted “${result.view.name}”.` };

  const message =
    result.reason === 'needs-share'
      ? `forbidden: the ${actor.role} role lacks the analytics:share permission (shared analytics view)`
      : 'no such saved view in this environment';
  await recordDenied(deps, {
    actor,
    action: SAVED_VIEW_ACTIONS.delete,
    target: id,
    environment: env.id,
    error: result.reason === 'not-yours' ? `${message} (another user's personal view)` : message,
  });
  return { error: `Not deleted: ${message}.` };
}
