'use client';

import { Field, Section, Toggle } from '@/components/designer/fields';
import { AccessMatrix } from '@/components/designer/access-matrix';
import { LimitEditor } from '@/components/designer/limits';
import { Input } from '@/components/ui/input';
import { slugify } from '@/lib/apis/draft';
import type { AccessHelp, ApiChoices } from '@/lib/designer/access';
import {
  DEFAULT_QUOTA,
  DEFAULT_RATE,
  withPolicyField,
  type PolicyHelpKey,
  type PolicyProblems,
} from '@/lib/policies/draft';
import type { Policy } from '@/lib/policies/list';

type Props = {
  draft: Policy;
  onChange: (draft: Policy) => void;
  /** The policy as loaded, for restoring a limit switched off and on; `null` when creating. */
  original: Policy | null;
  /** g2way's own description of each field (`policyFieldHelp()`). */
  help: Record<PolicyHelpKey, string>;
  problems: PolicyProblems;
  /** The environment's APIs for the access matrix, or why they could not be listed. */
  apis: ApiChoices;
  accessHelp: AccessHelp;
  readOnly: boolean;
};

/**
 * The structured half of the policy designer: identity, the active switch, the
 * two limits and the per-API access matrix, each editing the draft in place so
 * anything the form does not show survives.
 */
export function PolicyForm({
  draft,
  onChange,
  original,
  help,
  problems,
  apis,
  accessHelp,
  readOnly,
}: Props) {
  const creating = original === null;
  const set = <K extends keyof Policy>(key: K, value: Policy[K] | undefined) =>
    onChange(withPolicyField(draft, key, value));

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

      <AccessMatrix
        id="access"
        access={draft.access}
        onChange={(access) => set('access', access)}
        apis={apis}
        help={accessHelp}
        subject="keys applying this policy"
        replaceNote="A key that applies this policy uses this access, rate and quota instead of its own, replaced entirely rather than merged."
        problem={problems.access}
      />
    </fieldset>
  );
}
