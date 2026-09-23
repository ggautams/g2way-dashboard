'use client';

import { useMemo } from 'react';
import { Field, Toggle } from '@/components/designer/fields';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { withProp } from '@/lib/apis/auth';
import { formatHeaders, parseHeaderLines, problemsOf, type RuleHelp } from '@/lib/apis/rules';
import {
  BODY_DEFAULT_MAX_RESPONSE_BYTES,
  CORS_DEFAULT_METHODS,
  DIRECTIONS,
  mergeMasked,
  newBodyRule,
  newCors,
  splitMasked,
  TEMPLATE_VARIABLES,
  withBodyRules,
  withHeaderTransform,
  withMaxResponseBytes,
  withoutHeader,
  type BodyTransformRule,
  type BodyTransforms,
  type CorsConfig,
  type Direction,
  type HeaderTransform,
  type HeaderTransforms,
  type TransformHelp,
} from '@/lib/apis/transforms';
import { LinesField, NumberField } from './form-inputs';
import { BodyExtra } from './rule-fields';
import { MethodPicker, RuleList, useParsedText } from './rule-list';

/**
 * Editors for the header transforms, body transforms and CORS blocks. The
 * header and body editors take `inherited` for 2d's version overrides, where
 * each block is replaced wholesale (`VersioningConfig::apply`): absent or
 * `null` inherits the base's block, anything present overrides it. Problems
 * are read from the flat `DraftProblems` map under `prefix` (the field name
 * on the base, a per-version prefix in an override).
 */

type Problems = Readonly<Record<string, string | undefined>>;

const DIRECTION_LABEL: Record<Direction, string> = {
  request: 'Request (to the upstream)',
  response: 'Response (to the client)',
};

/**
 * The inherited/overridden banner of a block-valued version override, with
 * the button that switches between them. Renders nothing on the base
 * definition (`override` false).
 */
export function InheritedBlock({
  override,
  inheriting,
  what,
  onOverride,
  onInherit,
  readOnly,
}: {
  /** Whether this edits a version override at all. */
  override: boolean;
  /** Whether the override is absent, so the base's block applies. */
  inheriting: boolean;
  /** The block in words ("header transforms"). */
  what: string;
  onOverride: () => void;
  onInherit: () => void;
  readOnly: boolean;
}) {
  if (!override) return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 md:col-span-2">
      <p role="status" className="text-xs text-muted">
        {inheriting ? (
          <>
            <strong>Inherited from base</strong>: this version uses the base definition&apos;s{' '}
            {what}.
          </>
        ) : (
          <>
            <strong>Overridden</strong>: this version replaces the base definition&apos;s {what}{' '}
            wholesale.
          </>
        )}
      </p>
      {!readOnly && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          onClick={inheriting ? onOverride : onInherit}
        >
          {inheriting ? 'Override for this version' : 'Inherit from base'}
        </Button>
      )}
    </div>
  );
}

// ---- header transforms -----------------------------------------------------------

/**
 * `transform_headers`: per direction, headers to remove and headers to set.
 * g2way applies remove before add. `request.add` values are a secret path
 * (ADR-0010): a value masked for this role shows as hidden, never as text.
 * A version can override this block but not clear it (versioning.rs), so an
 * emptied override stays `{}` rather than going back to inheriting.
 */
export function HeaderTransformsEditor({
  id,
  value,
  inherited,
  onChange,
  help,
  problems,
  prefix,
  readOnly,
}: {
  /** DOM id prefix: `transform_headers`, or e.g. `v2.transform_headers`. */
  id: string;
  value: HeaderTransforms | null | undefined;
  /** Given only for a version override: the base definition's block. */
  inherited?: HeaderTransforms | null | undefined;
  onChange: (value: HeaderTransforms | undefined) => void;
  help: TransformHelp;
  problems: Problems;
  /** Where this block's problems are keyed (`transform_headers`). */
  prefix: string;
  readOnly: boolean;
}) {
  const override = inherited !== undefined;
  const inheriting = override && (value === undefined || value === null);
  const shown = (inheriting ? inherited : value) ?? {};
  const locked = readOnly || inheriting;
  return (
    <div id={id} className="grid gap-5 md:col-span-2 md:grid-cols-2">
      <InheritedBlock
        override={override}
        inheriting={inheriting}
        what="header transforms"
        onOverride={() => onChange({ ...(inherited ?? {}) })}
        onInherit={() => onChange(undefined)}
        readOnly={readOnly}
      />
      <fieldset disabled={locked} className="contents">
        {DIRECTIONS.map((direction) => (
          <HeaderDirection
            key={direction}
            id={`${id}.${direction}`}
            direction={direction}
            value={shown[direction]}
            onChange={(next) => onChange(withHeaderTransform(value, direction, next, override))}
            help={help}
            problems={problems}
            prefix={`${prefix}.${direction}`}
            readOnly={locked}
          />
        ))}
      </fieldset>
    </div>
  );
}

function HeaderDirection({
  id,
  direction,
  value,
  onChange,
  help,
  problems,
  prefix,
  readOnly,
}: {
  id: string;
  direction: Direction;
  value: HeaderTransform | undefined;
  onChange: (value: HeaderTransform) => void;
  help: TransformHelp;
  problems: Problems;
  prefix: string;
  readOnly: boolean;
}) {
  const t = value ?? {};
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <span className="text-sm font-medium">{DIRECTION_LABEL[direction]}</span>
      <p className="text-xs text-muted">
        {direction === 'request' ? help.headers_request : help.headers_response}
      </p>
      <LinesField
        id={`${id}.remove`}
        label="Remove (first)"
        help={help.remove}
        problem={problems[`${prefix}.remove`]}
        value={t.remove}
        rows={2}
        placeholder="One header name per line"
        onChange={(remove) => onChange(withProp(t, 'remove', remove))}
      />
      <HeaderAddField
        id={`${id}.add`}
        help={help.add}
        problem={problems[`${prefix}.add`]}
        value={t.add}
        readOnly={readOnly}
        onChange={(add) => onChange(withProp(t, 'add', add))}
      />
    </div>
  );
}

/**
 * Headers to set, as `Name: value` lines. A value this role may not see
 * (ADR-0010: `[secret hidden]`) is left out of the text and listed as hidden:
 * it can be removed, or replaced by typing the header again, but never shown
 * or edited, and `draftProblems` refuses a save that still carries it.
 */
export function HeaderAddField({
  id,
  label = 'Set',
  help,
  problem,
  value,
  readOnly,
  onChange,
}: {
  id: string;
  label?: string;
  help: string;
  problem?: string;
  value: Record<string, string> | undefined;
  readOnly: boolean;
  onChange: (value: Record<string, string> | undefined) => void;
}) {
  // Memoised: a new `open` object per render would resync the text forever.
  const { open, hidden } = useMemo(() => splitMasked(value), [value]);
  const {
    text,
    setText,
    problem: parseProblem,
  } = useParsedText(open, formatHeaders, parseHeaderLines);
  return (
    <Field id={id} label={label} help={help} problem={parseProblem ?? problem}>
      <Textarea
        id={id}
        rows={2}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder="X-Env: prod"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseHeaderLines(event.target.value);
          if (parsed.ok) onChange(mergeMasked(parsed.value, value, hidden));
        }}
      />
      {hidden.length > 0 && (
        <ul className="flex flex-col gap-1">
          {hidden.map((name) => (
            <li key={name} className="flex items-center gap-2 text-xs">
              <code className="font-mono">{name}</code>
              <span className="text-muted">
                Hidden: your role cannot see this value. Type the header again above to replace it.
              </span>
              {!readOnly && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => onChange(withoutHeader(value, name))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

// ---- body transforms -------------------------------------------------------------

/**
 * `transform_body`: request and response rule lists (regex + methods +
 * minijinja template, first match wins) and the response buffering cap. A
 * present block needs at least one rule, so on the base definition removing
 * the last rule removes the block.
 */
export function BodyTransformsEditor({
  id,
  value,
  inherited,
  onChange,
  help,
  ruleHelp,
  problems,
  prefix,
  listenPath,
  readOnly,
}: {
  /** DOM id prefix: `transform_body`, or e.g. `v2.transform_body`. */
  id: string;
  value: BodyTransforms | null | undefined;
  /** Given only for a version override: the base definition's block. */
  inherited?: BodyTransforms | null | undefined;
  onChange: (value: BodyTransforms | undefined) => void;
  help: TransformHelp;
  ruleHelp: RuleHelp;
  problems: Problems;
  /** Where this block's problems are keyed (`transform_body`). */
  prefix: string;
  listenPath: string;
  readOnly: boolean;
}) {
  const override = inherited !== undefined;
  const inheriting = override && (value === undefined || value === null);
  const shown = (inheriting ? inherited : value) ?? {};
  const locked = readOnly || inheriting;
  const blockProblem = problems[prefix];
  return (
    <div id={id} className="flex flex-col gap-5 md:col-span-2">
      <InheritedBlock
        override={override}
        inheriting={inheriting}
        what="body transforms"
        onOverride={() => onChange(structuredClone(inherited ?? {}))}
        onInherit={() => onChange(undefined)}
        readOnly={readOnly}
      />
      <p className="text-xs text-muted">
        Template variables:{' '}
        {TEMPLATE_VARIABLES.map(([name, meaning], index) => (
          <span key={name}>
            {index > 0 && '; '}
            <code className="font-mono">{name}</code> ({meaning})
          </span>
        ))}
        . Emit JSON values with <code className="font-mono">| tojson</code>.
      </p>
      {blockProblem && (
        <p role="alert" className="text-xs text-danger">
          {blockProblem}
        </p>
      )}
      <fieldset disabled={locked} className="contents">
        {DIRECTIONS.map((direction) => (
          <RuleList<BodyTransformRule>
            key={direction}
            id={`${id}.${direction}`}
            label={direction === 'request' ? 'Request bodies' : 'Response bodies'}
            help={direction === 'request' ? help.body_request : help.body_response}
            value={shown[direction]}
            onChange={(rules) => onChange(withBodyRules(value, direction, rules, override))}
            newRule={() => newBodyRule(listenPath)}
            problems={problemsOf(problems, `${prefix}.${direction}`)}
            ruleHelp={ruleHelp}
            empty={
              direction === 'request'
                ? 'Request bodies are forwarded as sent.'
                : 'Response bodies reach the client as sent.'
            }
            extra={BodyExtra}
            readOnly={locked}
          />
        ))}
        <NumberField
          id={`${id}.max_response_body_bytes`}
          label="Largest response body to transform (bytes)"
          help={help.max_response_body_bytes}
          problem={problems[`${prefix}.max_response_body_bytes`]}
          value={shown.max_response_body_bytes}
          min={1}
          placeholder={`${BODY_DEFAULT_MAX_RESPONSE_BYTES} (1 MiB)`}
          onChange={(bytes) => onChange(withMaxResponseBytes(value, bytes, override))}
        />
      </fieldset>
    </div>
  );
}

// ---- CORS ------------------------------------------------------------------------

/**
 * `cors`: shared by every version (built outside the version dispatcher), so
 * it has no inherited state. Off is no `cors` block; switching it on starts
 * with no origins, which the form then asks for.
 */
export function CorsEditor({
  value,
  onChange,
  help,
  problems,
}: {
  value: CorsConfig | null | undefined;
  onChange: (value: CorsConfig | undefined) => void;
  help: TransformHelp;
  problems: Problems;
}) {
  const cors = value ?? undefined;
  return (
    <>
      <Toggle
        id="cors"
        label="Answer CORS for this API"
        help={help.cors}
        checked={cors !== undefined}
        onChange={(on) => onChange(on ? newCors() : undefined)}
      />
      {cors && (
        <>
          <LinesField
            id="cors.allowed_origins"
            label="Allowed origins"
            help={help.allowed_origins}
            problem={problems['cors.allowed_origins']}
            value={cors.allowed_origins}
            placeholder={'https://app.example.com\n(or * alone for every origin)'}
            onChange={(origins) => onChange({ ...cors, allowed_origins: origins ?? [] })}
          />
          <MethodPicker
            id="cors.allowed_methods"
            label="Allowed methods"
            value={cors.allowed_methods}
            help={help.allowed_methods}
            problem={problems['cors.allowed_methods']}
            none={`${CORS_DEFAULT_METHODS.join(', ')}: g2way's default`}
            onChange={(methods) => onChange(withProp(cors, 'allowed_methods', methods))}
          />
          <LinesField
            id="cors.allowed_headers"
            label="Allowed request headers"
            help={help.allowed_headers}
            problem={problems['cors.allowed_headers']}
            value={cors.allowed_headers}
            placeholder="Empty: mirror what the preflight asks for"
            onChange={(headers) => onChange(withProp(cors, 'allowed_headers', headers))}
          />
          <LinesField
            id="cors.exposed_headers"
            label="Exposed response headers"
            help={help.exposed_headers}
            problem={problems['cors.exposed_headers']}
            value={cors.exposed_headers}
            placeholder="One header name per line"
            onChange={(headers) => onChange(withProp(cors, 'exposed_headers', headers))}
          />
          <div className="flex flex-col gap-1.5">
            <Toggle
              id="cors.allow_credentials"
              label="Allow credentials"
              help={help.allow_credentials}
              checked={cors.allow_credentials ?? false}
              onChange={(on) => onChange(withProp(cors, 'allow_credentials', on || undefined))}
            />
            {problems['cors.allow_credentials'] && (
              <p role="alert" className="text-xs text-danger">
                {problems['cors.allow_credentials']}
              </p>
            )}
          </div>
          <NumberField
            id="cors.max_age_secs"
            label="Preflight cache (seconds)"
            help={help.max_age_secs}
            value={cors.max_age_secs}
            min={0}
            placeholder="not sent"
            onChange={(secs) => onChange(withProp(cors, 'max_age_secs', secs))}
          />
          <Toggle
            id="cors.options_passthrough"
            label="Forward preflight requests upstream"
            help={help.options_passthrough}
            checked={cors.options_passthrough ?? false}
            onChange={(on) => onChange(withProp(cors, 'options_passthrough', on || undefined))}
          />
        </>
      )}
    </>
  );
}
