'use client';

import { Field, Section, Toggle, useSyncedText } from '@/components/designer/fields';
import { LimitEditor } from '@/components/designer/limits';
import { Input } from '@/components/ui/input';
import {
  fromDateTimeLocal,
  grantsEveryApi,
  toDateTimeLocal,
  withKeyField,
  type KeyHelpKey,
  type KeyProblems,
  type KeySession,
} from '@/lib/keys/session';
import { DEFAULT_QUOTA, DEFAULT_RATE } from '@/lib/policies/draft';

/** A policy the key may apply, as the select lists it. */
export type PolicyChoice = { id: string; name: string; active: boolean };

type Props = {
  draft: KeySession;
  onChange: (draft: KeySession) => void;
  /** The session as loaded, for restoring a limit switched off and on; `null` when creating. */
  original: KeySession | null;
  help: Record<KeyHelpKey, string>;
  problems: KeyProblems;
  /** The environment's policies, or why they could not be listed. */
  policies: { ok: true; value: readonly PolicyChoice[] } | { ok: false; error: string };
  readOnly: boolean;
};

const NO_POLICY = '';

/**
 * The structured half of the key designer: alias, the active switch (the soft
 * revoke), expiry, the one policy g2way applies, and the key's own limits,
 * each editing the draft in place so `access`, `hmac` and the rest survive.
 * The per-API access matrix is a later M4 task; `access` is raw-only until then.
 */
export function KeyForm({ draft, onChange, original, help, problems, policies, readOnly }: Props) {
  const set = <K extends keyof KeySession>(key: K, value: KeySession[K] | undefined) =>
    onChange(withKeyField(draft, key, value));
  const applied = draft.apply_policies?.[0] ?? NO_POLICY;
  const choices = policies.ok ? policies.value : [];
  const unknownPolicy = applied !== NO_POLICY && !choices.some((p) => p.id === applied);
  const apis = Object.keys(draft.access ?? {});

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-8 disabled:opacity-90">
      <Section title="Identity">
        <Field id="alias" label="Alias" help={help.alias} problem={problems.alias}>
          <Input
            id="alias"
            value={draft.alias ?? ''}
            onChange={(event) =>
              set('alias', event.target.value === '' ? undefined : event.target.value)
            }
          />
        </Field>
        <Toggle
          id="active"
          label="Active"
          help={`${help.active} Switching it off is a soft revoke.`}
          checked={draft.active ?? true}
          onChange={(value) => set('active', value)}
        />
        <ExpiryField
          value={draft.expires_at ?? null}
          help={help.expires_at}
          problem={problems.expires_at}
          onChange={(value) => set('expires_at', value ?? undefined)}
        />
      </Section>

      <Section title="Policy">
        <Field
          id="apply_policies"
          label="Applied policy"
          help={help.apply_policies}
          problem={
            problems.apply_policies ??
            (policies.ok ? undefined : `Could not list policies: ${policies.error}`)
          }
        >
          <select
            id="apply_policies"
            value={applied}
            onChange={(event) =>
              set(
                'apply_policies',
                event.target.value === NO_POLICY ? undefined : [event.target.value],
              )
            }
            className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-accent"
          >
            <option value={NO_POLICY}>None: the key&apos;s own limits and access</option>
            {unknownPolicy && <option value={applied}>{applied} (not in this environment)</option>}
            {choices.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name} ({policy.id}){policy.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </Field>
        {applied !== NO_POLICY && (
          <p role="status" className="self-center text-sm text-warning">
            While a policy is applied, its rate, quota and access replace the key&apos;s own at auth
            time; the limits below are kept but not used.
          </p>
        )}
      </Section>

      <Section title="Limits">
        <LimitEditor
          id="rate"
          label="Rate limit"
          help={help.rate}
          problem={problems.rate}
          value={draft.rate ?? null}
          start={original?.rate ?? DEFAULT_RATE}
          onChange={(rate) => set('rate', rate ?? undefined)}
          fields={[
            { key: 'requests', label: 'Requests', help: help['rate.requests'] },
            {
              key: 'per_seconds',
              label: 'Window (seconds)',
              help: help['rate.per_seconds'],
              seconds: true,
            },
          ]}
        />
        <LimitEditor
          id="quota"
          label="Quota"
          help={help.quota}
          problem={problems.quota}
          value={draft.quota ?? null}
          start={original?.quota ?? DEFAULT_QUOTA}
          onChange={(quota) => set('quota', quota ?? undefined)}
          fields={[
            { key: 'max', label: 'Maximum requests', help: help['quota.max'] },
            {
              key: 'renewal_rate_secs',
              label: 'Period (seconds)',
              help: help['quota.renewal_rate_secs'],
              seconds: true,
            },
          ]}
        />
      </Section>

      <section className="flex flex-col gap-2" aria-labelledby="key-access">
        <h2 id="key-access" className="text-sm font-semibold uppercase tracking-wide text-muted">
          API access
        </h2>
        {applied !== NO_POLICY ? (
          <p className="text-sm">
            From the policy <span className="font-mono">{applied}</span>.
          </p>
        ) : grantsEveryApi(draft) ? (
          <p role="status" className="text-sm text-warning">
            No access entries: this key may call <strong>every API in the organisation</strong>.
          </p>
        ) : (
          <p className="text-sm">
            {apis.length} API{apis.length === 1 ? '' : 's'}:{' '}
            <span className="font-mono text-xs">{apis.join(', ')}</span>
          </p>
        )}
        {problems.access && (
          <p role="alert" className="text-xs text-danger">
            {problems.access}
          </p>
        )}
        <p className="text-xs text-muted">
          {help.access} Edit <span className="font-mono">access</span> in the JSON or YAML view.
        </p>
      </section>
    </fieldset>
  );
}

/** Expiry as a local date and time; blank is "never". */
function ExpiryField({
  value,
  help,
  problem,
  onChange,
}: {
  value: number | null;
  help: string;
  problem?: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useSyncedText(value, toDateTimeLocal, fromDateTimeLocal);
  const typedInvalid = text !== '' && fromDateTimeLocal(text) === null;
  return (
    <Field
      id="expires_at"
      label="Expires"
      help={value === null ? `Never. ${help}` : help}
      problem={problem ?? (typedInvalid ? 'Not a valid date and time.' : undefined)}
    >
      <div className="flex items-center gap-2">
        <Input
          id="expires_at"
          type="datetime-local"
          className="w-60"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onChange(fromDateTimeLocal(event.target.value));
          }}
        />
        {value !== null && (
          <button
            type="button"
            className="text-xs text-muted underline"
            onClick={() => {
              setText('');
              onChange(null);
            }}
          >
            Never
          </button>
        )}
      </div>
    </Field>
  );
}
