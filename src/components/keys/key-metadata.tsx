'use client';

import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/auth/fields';
import { Notice } from '@/components/users/controls';
import {
  INITIAL_KEY_METADATA_FORM_STATE,
  KEY_METADATA_LIMITS,
  type KeyMetadataFields,
  type KeyMetadataFormState,
} from '@/lib/keys/metadata';

/** `saveKeyMetadataAction`, passed in by the page so client modules import nothing server-side. */
export type SaveKeyMetadata = (
  previous: KeyMetadataFormState,
  formData: FormData,
) => Promise<KeyMetadataFormState>;

/** Raw input text per field, as typed. */
export type KeyMetadataDraft = Record<keyof KeyMetadataFields, string>;

export const EMPTY_KEY_METADATA_DRAFT: KeyMetadataDraft = { label: '', owner: '', notes: '' };

const inputClass =
  'rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-70';

const HELP =
  'Kept in the dashboard database by key hash, not in the gateway: the gateway lists hashes only. Saving needs no reload.';

/**
 * The label, owner and notes inputs. Controlled when `value`/`onChange` are
 * given (the create flow), otherwise plain form fields with defaults.
 */
export function KeyMetadataInputs({
  value,
  onChange,
  defaults,
  disabled = false,
}: {
  value?: KeyMetadataDraft;
  onChange?: (next: KeyMetadataDraft) => void;
  defaults?: KeyMetadataFields | null;
  disabled?: boolean;
}) {
  const bind = (name: keyof KeyMetadataFields) =>
    value !== undefined && onChange !== undefined
      ? {
          value: value[name],
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onChange({ ...value, [name]: event.target.value }),
        }
      : { defaultValue: defaults?.[name] ?? '' };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Label</span>
        <input
          name="label"
          maxLength={KEY_METADATA_LIMITS.label}
          placeholder="What this key is for"
          autoComplete="off"
          disabled={disabled}
          className={inputClass}
          {...bind('label')}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Owner</span>
        <input
          name="owner"
          maxLength={KEY_METADATA_LIMITS.owner}
          placeholder="Team, customer or service"
          autoComplete="off"
          disabled={disabled}
          className={inputClass}
          {...bind('owner')}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        <span className="font-medium">Notes</span>
        <textarea
          name="notes"
          rows={3}
          maxLength={KEY_METADATA_LIMITS.notes}
          disabled={disabled}
          className={inputClass}
          {...bind('notes')}
        />
      </label>
    </div>
  );
}

/** The metadata section of a new key's page, filled in before the gateway creates it. */
export function NewKeyMetadata({
  value,
  onChange,
}: {
  value: KeyMetadataDraft;
  onChange: (next: KeyMetadataDraft) => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Dashboard metadata</h2>
        <p className="text-xs text-muted">
          {HELP} Saved under the new key&apos;s hash once the gateway has created it.
        </p>
      </div>
      <KeyMetadataInputs value={value} onChange={onChange} />
    </section>
  );
}

/**
 * A stored key's label, owner and notes: an audited form with `keys:write`
 * (`key.metadata.update`), read-only text otherwise.
 */
export function KeyMetadataEditor({
  hash,
  environment,
  stored,
  canWrite,
  action,
}: {
  hash: string;
  environment: string;
  stored: KeyMetadataFields | null;
  canWrite: boolean;
  action: SaveKeyMetadata;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_KEY_METADATA_FORM_STATE);
  const shown = state.saved ?? stored;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Dashboard metadata</h2>
        <p className="text-xs text-muted">{HELP}</p>
      </div>
      {canWrite ? (
        <form action={formAction} className="flex flex-col gap-3">
          <FormError message={state.error} />
          <Notice message={state.notice} />
          <input type="hidden" name="environment" value={environment} />
          <input type="hidden" name="hash" value={hash} />
          {/* Keyed on what is stored, so a save shows the normalised values. */}
          <KeyMetadataInputs key={JSON.stringify(shown)} defaults={shown} />
          <div>
            <SubmitButton pending={pending}>Save metadata</SubmitButton>
          </div>
        </form>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
          {(['label', 'owner', 'notes'] as const).map((name) => (
            <div key={name} className="contents">
              <dt className="font-medium capitalize">{name}</dt>
              <dd className="whitespace-pre-wrap text-muted">{shown?.[name] ?? '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
