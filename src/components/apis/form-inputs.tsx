'use client';

import { Field, useSyncedText } from '@/components/designer/fields';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseLines } from '@/lib/apis/auth';
import { parseWholeNumber } from '@/lib/apis/draft';

/**
 * Inputs the API form's editors share. Each edits one optional value in
 * place: blank means "unset", which is g2way's default (see `withField`).
 */

/** A whole number; blank is `undefined`, an out-of-range entry a problem that is not applied. */
export function NumberField({
  id,
  label,
  help,
  value,
  min,
  max,
  placeholder = 'g2way default',
  problem,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: number | null | undefined;
  min: number;
  max?: number;
  placeholder?: string;
  problem?: string;
  onChange: (value: number | undefined) => void;
}) {
  const parse = (text: string) => {
    const parsed = parseWholeNumber(text, min, max);
    return parsed.ok ? parsed.value : undefined;
  };
  const [text, setText] = useSyncedText(
    value ?? undefined,
    (v) => (v === undefined ? '' : String(v)),
    parse,
  );
  const parsed = parseWholeNumber(text, min, max);
  return (
    <Field id={id} label={label} help={help} problem={parsed.ok ? problem : parsed.problem}>
      <Input
        id={id}
        inputMode="numeric"
        className="w-40 font-mono"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseWholeNumber(event.target.value, min, max);
          if (next.ok) onChange(next.value);
        }}
      />
    </Field>
  );
}

/** A list of strings, one per line; no lines is `undefined`. */
export function LinesField({
  id,
  label,
  help,
  value,
  placeholder,
  problem,
  rows = 3,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: readonly string[] | undefined;
  placeholder: string;
  problem?: string;
  rows?: number;
  onChange: (value: string[] | undefined) => void;
}) {
  const [text, setText] = useSyncedText(value, (v) => (v ?? []).join('\n'), parseLines);
  return (
    <Field id={id} label={label} help={help} problem={problem}>
      <Textarea
        id={id}
        rows={rows}
        className="font-mono text-xs"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseLines(event.target.value));
        }}
      />
    </Field>
  );
}

/**
 * One line of text. `blank` says what an empty box means: `unset` removes the
 * value (g2way's default, shown as the placeholder), `empty` keeps `''` for a
 * value that is required, so the problem shows.
 */
export function TextField({
  id,
  label,
  help,
  value,
  placeholder,
  problem,
  blank,
  type = 'text',
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: string | null | undefined;
  placeholder?: string;
  problem?: string;
  blank: 'unset' | 'empty';
  type?: 'text' | 'url' | 'password';
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Field id={id} label={label} help={help} problem={problem}>
      <Input
        id={id}
        type={type}
        autoComplete="off"
        className="font-mono"
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(event) => {
          const text = event.target.value;
          onChange(text === '' && blank === 'unset' ? undefined : text);
        }}
      />
    </Field>
  );
}
