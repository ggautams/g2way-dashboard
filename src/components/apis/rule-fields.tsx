'use client';

import { Field } from '@/components/designer/fields';
import { LimitInput, type LimitField } from '@/components/designer/limits';
import { Textarea } from '@/components/ui/textarea';
import { withProp } from '@/lib/apis/auth';
import {
  formatHeaders,
  MOCK_DEFAULT_STATUS,
  parseHeaderLines,
  type EndpointRateLimit,
  type MockResponse,
  type RateLimit,
  type UrlRewriteRule,
} from '@/lib/apis/rules';
import { BODY_DEFAULT_CONTENT_TYPE, type BodyTransformRule } from '@/lib/apis/transforms';
import { NumberField, TextField } from './form-inputs';
import { useParsedText, type RuleExtra } from './rule-list';

/**
 * The per-kind settings each rule list adds after the pattern and methods,
 * for `<RuleList extra={…}>`, so the same kind renders the same way on the
 * base definition and in a version override (2d). Module-level components:
 * a new function per render would remount the inputs and lose focus.
 */

export const RewriteExtra: RuleExtra<UrlRewriteRule> = ({ rule, onChange, id, problems, help }) => (
  <TextField
    id={`${id}.rewrite`}
    label="Rewrite to"
    help={help.rewrite}
    problem={problems.rewrite}
    value={rule.rewrite}
    placeholder="/new/$1"
    blank="empty"
    onChange={(rewrite) => onChange({ ...rule, rewrite: rewrite ?? '' })}
  />
);

export const MockExtra: RuleExtra<MockResponse> = ({ rule, onChange, id, problems, help }) => (
  <>
    <NumberField
      id={`${id}.status`}
      label="Status"
      help={help.status}
      problem={problems.status}
      value={rule.status}
      min={100}
      max={599}
      placeholder={String(MOCK_DEFAULT_STATUS)}
      onChange={(status) => onChange(withProp(rule, 'status', status))}
    />
    <MockHeaders
      id={`${id}.headers`}
      help={help.headers}
      problem={problems.headers}
      value={rule.headers}
      onChange={(headers) => onChange(withProp(rule, 'headers', headers))}
    />
    <Field id={`${id}.body`} label="Body" help={help.body}>
      <Textarea
        id={`${id}.body`}
        rows={3}
        className="font-mono text-xs"
        placeholder="Empty"
        value={rule.body ?? ''}
        onChange={(event) => onChange(withProp(rule, 'body', event.target.value || undefined))}
      />
    </Field>
  </>
);

function MockHeaders({
  id,
  help,
  problem,
  value,
  onChange,
}: {
  id: string;
  help: string;
  problem?: string;
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
}) {
  const {
    text,
    setText,
    problem: parseProblem,
  } = useParsedText(value, formatHeaders, parseHeaderLines);
  return (
    <Field id={id} label="Headers" help={help} problem={parseProblem ?? problem}>
      <Textarea
        id={id}
        rows={2}
        className="font-mono text-xs"
        placeholder="Content-Type: application/json"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseHeaderLines(event.target.value);
          if (parsed.ok) onChange(parsed.value);
        }}
      />
    </Field>
  );
}

export const RateExtra: RuleExtra<EndpointRateLimit> = ({ rule, onChange, id, problems, help }) => {
  const fields: readonly LimitField<keyof RateLimit>[] = [
    { key: 'requests', label: 'Requests', help: help.requests },
    { key: 'per_seconds', label: 'Per (seconds)', help: help.per_seconds, seconds: true },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-4">
        {fields.map((field) => (
          <LimitInput
            key={field.key}
            id={`${id}.rate.${field.key}`}
            field={field}
            value={rule.rate[field.key]}
            onChange={(n) => onChange({ ...rule, rate: { ...rule.rate, [field.key]: n } })}
          />
        ))}
      </div>
      {problems.rate && (
        <p role="alert" className="text-xs text-danger">
          {problems.rate}
        </p>
      )}
    </div>
  );
};

/** A body-transform rule's minijinja template and the Content-Type it sets. */
export const BodyExtra: RuleExtra<BodyTransformRule> = ({ rule, onChange, id, problems, help }) => (
  <>
    <Field id={`${id}.template`} label="Template" help={help.template} problem={problems.template}>
      <Textarea
        id={`${id}.template`}
        rows={4}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder="{{ body | tojson }}"
        value={rule.template}
        onChange={(event) => onChange({ ...rule, template: event.target.value })}
      />
    </Field>
    <TextField
      id={`${id}.content_type`}
      label="Content-Type"
      help={help.content_type}
      problem={problems.content_type}
      value={rule.content_type}
      placeholder={BODY_DEFAULT_CONTENT_TYPE}
      blank="unset"
      onChange={(contentType) => onChange(withProp(rule, 'content_type', contentType))}
    />
  </>
);
