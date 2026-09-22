'use client';

import { Field, Toggle, useSyncedText } from '@/components/designer/fields';
import { Input } from '@/components/ui/input';
import { parseLimit } from '@/lib/policies/draft';
import { describeSeconds } from '@/lib/policies/list';

/**
 * A nullable rate or quota editor, shared by the policy and key designers:
 * g2way's `RateLimit` and `Quota` have the same rules on both (`Policy::validate`
 * and `KeySession::validate` refuse zero; absent means unlimited).
 */

export type LimitField<K extends string> = {
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
export function LimitEditor<K extends string>({
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
