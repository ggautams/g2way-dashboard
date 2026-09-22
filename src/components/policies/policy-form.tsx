'use client';

import { Field, Section, Toggle, useSyncedText } from '@/components/designer/fields';
import { Input } from '@/components/ui/input';
import { slugify } from '@/lib/apis/draft';
import {
  DEFAULT_QUOTA,
  DEFAULT_RATE,
  grantsEveryApi,
  parseLimit,
  withPolicyField,
  type PolicyHelpKey,
  type PolicyProblems,
} from '@/lib/policies/draft';
import { describeSeconds, type Policy } from '@/lib/policies/list';

type Props = {
  draft: Policy;
  onChange: (draft: Policy) => void;
  /** The policy as loaded, for restoring a limit switched off and on; `null` when creating. */
  original: Policy | null;
  /** g2way's own description of each field (`policyFieldHelp()`). */
  help: Record<PolicyHelpKey, string>;
  problems: PolicyProblems;
  readOnly: boolean;
};

/**
 * The structured half of the policy designer: identity, the active switch and
 * the two limits, each editing the draft in place so `access` and anything
 * else survive. `access` is shown, not edited: the raw view edits it until the
 * access matrix lands.
 */
export function PolicyForm({ draft, onChange, original, help, problems, readOnly }: Props) {
  const creating = original === null;
  const set = <K extends keyof Policy>(key: K, value: Policy[K] | undefined) =>
    onChange(withPolicyField(draft, key, value));
  const apis = Object.keys(draft.access ?? {});

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-8 disabled:opacity-90">
      <Section title="Identity">
        <Field id="name" label="Name" help={help.name} problem={problems.name}>
          <Input
            id="name"
            value={draft.name}
            onChange={(event) => {
              const name = event.target.value;
              // While creating, keep suggesting an id until the user types their own.
              const suggest = creating && draft.policy_id === slugify(draft.name);
              onChange({ ...draft, name, ...(suggest ? { policy_id: slugify(name) } : {}) });
            }}
          />
        </Field>
        <Field id="policy_id" label="Policy id" help={help.policy_id} problem={problems.policy_id}>
          <Input
            id="policy_id"
            className="font-mono"
            value={draft.policy_id}
            readOnly={!creating}
            title={creating ? undefined : 'Keys reference the policy by this id; it cannot change.'}
            onChange={(event) => set('policy_id', event.target.value)}
          />
        </Field>
        <Toggle
          id="active"
          label="Active"
          help={help.active}
          checked={draft.active ?? true}
          onChange={(value) => set('active', value)}
        />
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

      <section className="flex flex-col gap-2" aria-labelledby="policy-access">
        <h2 id="policy-access" className="text-sm font-semibold uppercase tracking-wide text-muted">
          API access
        </h2>
        {grantsEveryApi(draft) ? (
          <p role="status" className="text-sm text-warning">
            No access entries: keys applying this policy may call{' '}
            <strong>every API in the organisation</strong>.
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

type LimitField<K extends string> = {
  key: K;
  label: string;
  help: string;
  /** Show the value as a duration too. */
  seconds?: boolean;
};

/**
 * A nullable limit: off is `null` (unlimited, which the draft writes as no
 * field at all); on, every field is a whole number of at least 1. Switching on
 * starts from the loaded policy's limit, or the contract's example.
 */
function LimitEditor<K extends string>({
  id,
  label,
  help,
  problem,
  value,
  start,
  onChange,
  fields,
}: {
  id: string;
  label: string;
  help: string;
  problem?: string;
  value: Record<K, number> | null;
  start: Record<K, number>;
  onChange: (value: Record<K, number> | null) => void;
  fields: readonly LimitField<K>[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        id={id}
        label={label}
        help={help}
        checked={value !== null}
        onChange={(on) => onChange(on ? start : null)}
      />
      {value !== null && (
        <div className="flex flex-wrap gap-4 pl-12">
          {fields.map((field) => (
            <LimitInput
              key={field.key}
              id={`${id}.${field.key}`}
              field={field}
              value={value[field.key]}
              onChange={(n) => onChange({ ...value, [field.key]: n })}
            />
          ))}
        </div>
      )}
      {problem && (
        <p role="alert" className="pl-12 text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

function LimitInput<K extends string>({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: LimitField<K>;
  value: number;
  onChange: (value: number) => void;
}) {
  // Text that does not parse is written as 0, which g2way refuses: the draft
  // then carries the problem (and blocks the save) instead of a stale value.
  const toNumber = (text: string) => {
    const parsed = parseLimit(text);
    return parsed.ok ? parsed.value : 0;
  };
  const [text, setText] = useSyncedText(value, (v) => (v === 0 ? '' : String(v)), toNumber);
  const parsed = parseLimit(text);
  return (
    <Field
      id={id}
      label={field.label}
      help={
        field.seconds && parsed.ok ? `${describeSeconds(parsed.value)}. ${field.help}` : field.help
      }
      problem={parsed.ok ? undefined : parsed.problem}
    >
      <Input
        id={id}
        inputMode="numeric"
        className="w-40 font-mono"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(toNumber(event.target.value));
        }}
      />
    </Field>
  );
}
