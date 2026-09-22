'use client';

import { Field, Section, Toggle, useSyncedText } from '@/components/designer/fields';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  parseTargetList,
  parseWholeNumber,
  slugify,
  withAuthMode,
  withField,
  type FormField,
} from '@/lib/apis/draft';
import { AUTH_MODES, summarise, type ApiDefinition, type AuthMode } from '@/lib/apis/list';

type Props = {
  draft: ApiDefinition;
  onChange: (draft: ApiDefinition) => void;
  /** The definition as loaded, for restoring its auth config; `null` when creating. */
  original: ApiDefinition | null;
  /** g2way's own description of each field (`fieldHelp()`). */
  help: Record<FormField, string>;
  problems: Partial<Record<FormField, string>>;
  readOnly: boolean;
};

/**
 * The structured half of the API designer: the fields most APIs need, each
 * editing the draft in place (`withField`), so fields not shown here survive.
 */
export function ApiForm({ draft, onChange, original, help, problems, readOnly }: Props) {
  const creating = original === null;
  const summary = summarise(draft);
  const set = <K extends keyof ApiDefinition>(key: K, value: ApiDefinition[K] | undefined) =>
    onChange(withField(draft, key, value));

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
              const suggest = creating && draft.api_id === slugify(draft.name);
              onChange({ ...draft, name, ...(suggest ? { api_id: slugify(name) } : {}) });
            }}
          />
        </Field>
        <Field id="api_id" label="API id" help={help.api_id} problem={problems.api_id}>
          <Input
            id="api_id"
            className="font-mono"
            value={draft.api_id}
            readOnly={!creating}
            title={creating ? undefined : 'The id names the stored definition; it cannot change.'}
            onChange={(event) => set('api_id', event.target.value)}
          />
        </Field>
      </Section>

      <Section title="Routing">
        <Field
          id="listen_path"
          label="Listen path"
          help={help.listen_path}
          problem={problems.listen_path}
        >
          <Input
            id="listen_path"
            className="font-mono"
            value={draft.listen_path}
            onChange={(event) => set('listen_path', event.target.value)}
          />
        </Field>
        <Toggle
          id="strip_listen_path"
          label="Strip the listen path"
          help={help.strip_listen_path}
          checked={draft.strip_listen_path ?? true}
          onChange={(value) => set('strip_listen_path', value)}
        />
        <Field
          id="target_url"
          label="Upstream URL"
          help={help.target_url}
          problem={problems.target_url}
        >
          <Input
            id="target_url"
            type="url"
            className="font-mono"
            value={draft.target_url}
            onChange={(event) => set('target_url', event.target.value)}
          />
        </Field>
        <TargetList
          value={draft.target_list}
          onChange={(list) => set('target_list', list)}
          help={help.target_list}
          problem={problems.target_list}
        />
      </Section>

      <Section title="Access">
        <Toggle
          id="active"
          label="Active"
          help={help.active}
          checked={summary.active}
          onChange={(value) => set('active', value)}
        />
        <Field id="auth" label="Authentication" help={help.auth}>
          <Select
            value={summary.authMode}
            onValueChange={(mode) =>
              onChange(withAuthMode(draft, mode as AuthMode, original?.auth))
            }
            disabled={readOnly}
          >
            <SelectTrigger id="auth" className="w-56 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_MODES.map((mode) => (
                <SelectItem key={mode} value={mode} className="font-mono">
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.auth !== undefined &&
            draft.auth.mode !== 'keyless' &&
            draft.auth.mode !== original?.auth?.mode && (
              <p className="text-xs text-warning">
                {draft.auth.mode} needs settings of its own (keys, issuers, realms); set them in the
                raw definition before saving.
              </p>
            )}
        </Field>
      </Section>

      <Section title="Upstream">
        <Toggle
          id="preserve_host_header"
          label="Preserve the Host header"
          help={help.preserve_host_header}
          checked={draft.preserve_host_header ?? false}
          onChange={(value) => set('preserve_host_header', value)}
        />
        <NumberField
          id="upstream_timeout_ms"
          label="Timeout (ms)"
          help={help.upstream_timeout_ms}
          value={draft.upstream_timeout_ms}
          min={1}
          onChange={(value) => set('upstream_timeout_ms', value)}
        />
        <NumberField
          id="upstream_retries"
          label="Retries"
          help={help.upstream_retries}
          value={draft.upstream_retries}
          min={0}
          max={10}
          onChange={(value) => set('upstream_retries', value)}
        />
      </Section>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: number | undefined;
  min: number;
  max?: number;
  onChange: (value: number | undefined) => void;
}) {
  const parse = (text: string) => {
    const parsed = parseWholeNumber(text, min, max);
    return parsed.ok ? parsed.value : undefined;
  };
  const [text, setText] = useSyncedText(value, (v) => (v === undefined ? '' : String(v)), parse);
  const parsed = parseWholeNumber(text, min, max);
  return (
    <Field id={id} label={label} help={help} problem={parsed.ok ? undefined : parsed.problem}>
      <Input
        id={id}
        inputMode="numeric"
        className="w-40 font-mono"
        placeholder="g2way default"
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

function TargetList({
  value,
  onChange,
  help,
  problem,
}: {
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  help: string;
  problem?: string;
}) {
  const [text, setText] = useSyncedText(value, (v) => (v ?? []).join('\n'), parseTargetList);
  return (
    <Field id="target_list" label="Load-balanced targets" help={help} problem={problem}>
      <Textarea
        id="target_list"
        rows={3}
        className="font-mono text-xs"
        placeholder="One URL per line (optional)"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseTargetList(event.target.value));
        }}
      />
    </Field>
  );
}
