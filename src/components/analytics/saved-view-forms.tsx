'use client';

import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/auth/fields';
import { Notice } from '@/components/users/controls';
import {
  INITIAL_SAVED_VIEW_FORM_STATE,
  MAX_VIEW_NAME,
  type SavedViewFormState,
} from '@/lib/analytics/saved-views';

/** A saved-view server action, passed in by the page so this module imports nothing server-side. */
export type SavedViewAction = (
  previous: SavedViewFormState,
  formData: FormData,
) => Promise<SavedViewFormState>;

/**
 * Saves the view on screen under a name (ADR-0016). `query` is the page's own
 * canonical query; the action canonicalises it again. The share box shows
 * only for roles with `analytics:share`.
 */
export function SaveViewForm({
  action,
  environment,
  query,
  canShare,
}: {
  action: SavedViewAction;
  environment: string;
  query: string;
  canShare: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_SAVED_VIEW_FORM_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="query" value={query} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Save this view as</span>
          <input
            name="name"
            required
            maxLength={MAX_VIEW_NAME}
            placeholder="Checkout 5xx, last 24 hours"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        {canShare && (
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="shared" />
            Share with everyone in this environment
          </label>
        )}
        <SubmitButton pending={pending}>Save view</SubmitButton>
      </div>
      <FormError message={state.error} />
      <Notice message={state.notice} />
    </form>
  );
}

/** Deletes one saved view; the refusal, if any, shows beside it. */
export function DeleteViewButton({
  action,
  environment,
  id,
  name,
}: {
  action: SavedViewAction;
  environment: string;
  id: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_SAVED_VIEW_FORM_STATE);
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Delete saved view ${name}`}
        className="rounded px-1.5 text-xs text-muted hover:bg-subtle hover:text-danger disabled:opacity-60"
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {state.error !== null && (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      )}
    </form>
  );
}
