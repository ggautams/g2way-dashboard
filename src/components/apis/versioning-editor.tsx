'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Field, Toggle, useSyncedText } from '@/components/designer/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TRANSFORM_METHODS } from '@/lib/apis/auth';
import { DISPATCHER_ID, editorAnchor, FORWARDER_ID } from '@/lib/apis/chain';
import { withField, type ApiHelp, type DraftProblems } from '@/lib/apis/draft';
import type { ApiDefinition } from '@/lib/apis/list';
import {
  newRule,
  problemsOf,
  type EndpointRateLimit,
  type MockResponse,
  type PathRule,
  type RuleList as RuleListName,
  type RuleOf,
  type UrlRewriteRule,
} from '@/lib/apis/rules';
import {
  addVersion,
  DEFAULT_VERSION_KEY,
  DEFERRED_OVERRIDES,
  deferredOverrides,
  formatExpiry,
  isExpired,
  parseExpiry,
  removeVersion,
  renameProblem,
  renameVersion,
  SHARED_FIELDS,
  VERSION_LOCATIONS,
  versionDomId,
  versionPrefix,
  withOverride,
  withSetting,
  withVersioning,
  type OverrideField,
  type VersioningConfig,
  type VersionLocation,
  type VersionOverrides,
} from '@/lib/apis/versioning';
import { TextField } from './form-inputs';
import { MockExtra, RateExtra, RewriteExtra } from './rule-fields';
import { RuleList } from './rule-list';
import { BodyTransformsEditor, HeaderTransformsEditor } from './transform-editors';

/**
 * The versioning editor: the dispatcher's settings (where the version is
 * read, the default) and one card per version, whose override sections reuse
 * the base editors with `inherited` set, so each starts as "inherited from
 * base". Each version's sections carry `editorAnchor(slotId, name)`, and the
 * card `editorAnchor(DISPATCHER_ID, name)`, for the Chain tab's per-version
 * links (`VERSION_EDITOR_SLOTS`). Overrides the form does not edit
 * (`DEFERRED_OVERRIDES`) are never touched and are listed per version.
 */

/** The Select's value for "no default": a padded name can never be a version (versioning.rs). */
const NO_DEFAULT = ' ';
/** The Select's value for "inherit the base's method". */
const INHERIT = 'inherit';

const LOCATION_LABEL: Record<VersionLocation, string> = {
  header: 'A request header',
  query_param: 'A query parameter',
};

type Props = {
  draft: ApiDefinition;
  onChange: (draft: ApiDefinition) => void;
  /** The versioning the definition was loaded with, restored when turned back on. */
  original: VersioningConfig | null | undefined;
  help: ApiHelp;
  problems: DraftProblems;
  readOnly: boolean;
};

export function VersioningEditor({ draft, onChange, original, help, problems, readOnly }: Props) {
  const cfg = draft.versioning ?? undefined;
  const setCfg = (next: VersioningConfig) => onChange(withField(draft, 'versioning', next));
  const names = cfg === undefined ? [] : Object.keys(cfg.versions);
  return (
    <>
      <Toggle
        id="versioning"
        label="Serve several versions of this API"
        help={help.fields.versioning}
        checked={cfg !== undefined}
        onChange={(on) => onChange(withVersioning(draft, on, original))}
      />
      {cfg !== undefined && (
        <>
          <Field id="versioning.location" label="Version read from" help={help.versioning.location}>
            <Select
              value={cfg.location ?? 'header'}
              onValueChange={(location) =>
                setCfg(withSetting(cfg, 'location', location as VersionLocation))
              }
              disabled={readOnly}
            >
              <SelectTrigger id="versioning.location" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERSION_LOCATIONS.map((location) => (
                  <SelectItem key={location} value={location}>
                    {LOCATION_LABEL[location]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <TextField
            id="versioning.key"
            label={cfg.location === 'query_param' ? 'Query parameter' : 'Header'}
            help={help.versioning.key}
            problem={problems['versioning.key']}
            value={cfg.key}
            placeholder={DEFAULT_VERSION_KEY}
            blank="unset"
            onChange={(key) => setCfg(withSetting(cfg, 'key', key))}
          />
          <Field
            id="versioning.default_version"
            label="Default version"
            help={help.versioning.default_version}
            problem={problems['versioning.default_version']}
          >
            <Select
              value={cfg.default_version ?? NO_DEFAULT}
              onValueChange={(name) =>
                setCfg(withSetting(cfg, 'default_version', name === NO_DEFAULT ? undefined : name))
              }
              disabled={readOnly}
            >
              <SelectTrigger id="versioning.default_version" className="w-72 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEFAULT}>
                  None: a version is required (403 otherwise)
                </SelectItem>
                {names.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-col gap-1 text-xs text-muted">
            <p>
              <strong>Inherited from base, shared by all versions</strong> (built once around the
              version dispatcher, or read from the base by every version):{' '}
              {SHARED_FIELDS.map(({ label, slot }, index) => (
                <span key={slot}>
                  {index > 0 && ', '}
                  <a href={`#${editorAnchor(slot)}`} className="text-accent hover:underline">
                    {label}
                  </a>
                </span>
              ))}
              , and the routing settings.
            </p>
            <p>
              Edit in JSON/YAML: a version&apos;s{' '}
              {Object.keys(DEFERRED_OVERRIDES).map((field, index) => (
                <span key={field}>
                  {index > 0 && ', '}
                  <code className="font-mono">{field}</code>
                </span>
              ))}{' '}
              overrides. The form keeps them as they are.
            </p>
          </div>
          {problems['versioning.versions'] && (
            <p role="alert" className="text-xs text-danger md:col-span-2">
              {problems['versioning.versions']}
            </p>
          )}
          <p className="text-xs text-muted md:col-span-2">{help.versioning.overrides}</p>
          {Object.entries(cfg.versions).map(([name, overrides]) => (
            <VersionCard
              key={name}
              name={name}
              overrides={overrides}
              cfg={cfg}
              setCfg={setCfg}
              draft={draft}
              help={help}
              problems={problems}
              readOnly={readOnly}
            />
          ))}
          {!readOnly && (
            <div className="md:col-span-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCfg(addVersion(cfg))}
              >
                <PlusIcon /> Add version
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** One heading and grid inside a version card, anchored for the Chain tab's links. */
function Part({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="flex scroll-mt-4 flex-col gap-3">
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="grid gap-5 md:grid-cols-2">{children}</div>
    </div>
  );
}

function VersionCard({
  name,
  overrides,
  cfg,
  setCfg,
  draft,
  help,
  problems,
  readOnly,
}: {
  name: string;
  overrides: VersionOverrides;
  cfg: VersioningConfig;
  setCfg: (cfg: VersioningConfig) => void;
  draft: ApiDefinition;
  help: ApiHelp;
  problems: DraftProblems;
  readOnly: boolean;
}) {
  const prefix = versionPrefix(name);
  const dom = versionDomId(name);
  const deferred = deferredOverrides(overrides);
  const set = <K extends OverrideField>(field: K, value: VersionOverrides[K] | undefined) =>
    setCfg(withOverride(cfg, name, field, value));
  // What every override rule list shares: the base's rules as `inherited`, and per-version keys.
  const rules = <L extends RuleListName>(list: L) => ({
    id: `${dom}.${list}`,
    help: help.fields[list],
    value: overrides[list] as readonly RuleOf<L>[] | null | undefined,
    inherited: (draft[list] ?? null) as readonly RuleOf<L>[] | null,
    onChange: (value: RuleOf<L>[] | undefined) =>
      set(list, value as VersionOverrides[L] | undefined),
    newRule: () => newRule(list, draft.listen_path),
    problems: problemsOf(problems, `${prefix}.${list}`),
    ruleHelp: help.rules,
    readOnly,
  });
  const only = Object.keys(cfg.versions).length === 1;

  return (
    <section
      id={editorAnchor(DISPATCHER_ID, name)}
      aria-label={`Version ${name}`}
      className="flex scroll-mt-4 flex-col gap-6 rounded-lg border border-border p-4 md:col-span-2"
    >
      <div className="grid gap-5 md:grid-cols-2">
        <VersionName
          id={`${dom}.name`}
          name={name}
          cfg={cfg}
          problem={problems[`${prefix}.name`]}
          isDefault={cfg.default_version === name}
          onRename={(to) => setCfg(renameVersion(cfg, name, to))}
        />
        <ExpiresField
          id={`${dom}.expires_at`}
          help={help.versioning.expires_at}
          value={overrides.expires_at}
          onChange={(secs) => set('expires_at', secs)}
        />
        {deferred.length > 0 && (
          <p role="status" className="text-xs text-muted md:col-span-2">
            Also overrides{' '}
            {deferred.map((field, index) => (
              <span key={field}>
                {index > 0 && ', '}
                <code className="font-mono">{field}</code>
              </span>
            ))}
            : edit in JSON/YAML. The form keeps them as they are.
          </p>
        )}
        {!readOnly && (
          <div className="md:col-span-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={only}
              title={
                only ? 'A versioned API needs a version; turn versioning off instead.' : undefined
              }
              onClick={() => setCfg(removeVersion(cfg, name))}
            >
              <Trash2Icon /> Remove {name}
            </Button>
          </div>
        )}
      </div>

      <Part id={editorAnchor('path-policy', name)} title="Path rules">
        <RuleList<PathRule>
          {...rules('block_paths')}
          label="Block"
          empty="Nothing is blocked by path."
        />
        <RuleList<PathRule>
          {...rules('allow_paths')}
          label="Allow only"
          empty="Every path is allowed."
        />
        <RuleList<PathRule>
          {...rules('ignore_auth_paths')}
          label="Skip authentication"
          empty="Every path authenticates."
        />
      </Part>

      <Part id={editorAnchor('rate-limit', name)} title="Endpoint rate limits">
        <RuleList<EndpointRateLimit>
          {...rules('endpoint_rate_limits')}
          label="Limits for all clients combined"
          empty="Only each key's own rate and quota apply."
          extra={RateExtra}
        />
      </Part>

      <Part id={editorAnchor('transform-headers', name)} title="Header transforms">
        <HeaderTransformsEditor
          id={`${dom}.transform_headers`}
          value={overrides.transform_headers}
          inherited={draft.transform_headers ?? null}
          onChange={(value) => set('transform_headers', value)}
          help={help.transforms}
          problems={problems}
          prefix={`${prefix}.transform_headers`}
          readOnly={readOnly}
        />
      </Part>

      <Part id={editorAnchor('transform-body', name)} title="Body transforms">
        <BodyTransformsEditor
          id={`${dom}.transform_body`}
          value={overrides.transform_body}
          inherited={draft.transform_body ?? null}
          onChange={(value) => set('transform_body', value)}
          help={help.transforms}
          ruleHelp={help.rules}
          problems={problems}
          prefix={`${prefix}.transform_body`}
          listenPath={draft.listen_path}
          readOnly={readOnly}
        />
      </Part>

      <Part id={editorAnchor('mock', name)} title="Mock responses">
        <RuleList<MockResponse>
          {...rules('mock_responses')}
          label="Answer without the upstream"
          empty="Every request that gets this far is forwarded."
          extra={MockExtra}
        />
      </Part>

      <Part id={editorAnchor(FORWARDER_ID, name)} title="Upstream">
        <TextField
          id={`${dom}.target_url`}
          label="Upstream URL"
          help={help.versioning.target_url}
          problem={problems[`${prefix}.target_url`]}
          value={overrides.target_url}
          placeholder={`Inherited: ${draft.target_url || '(base upstream)'}`}
          blank="unset"
          type="url"
          onChange={(url) => set('target_url', url)}
        />
        <Field
          id={`${dom}.transform_method`}
          label="Method sent upstream"
          help={`${help.versioning.transform_method} A version can override the base's method but not clear it.`}
          problem={problems[`${prefix}.transform_method`]}
        >
          <Select
            value={overrides.transform_method?.toUpperCase() ?? INHERIT}
            onValueChange={(method) =>
              set('transform_method', method === INHERIT ? undefined : method)
            }
            disabled={readOnly}
          >
            <SelectTrigger id={`${dom}.transform_method`} className="w-72 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                Inherited: {draft.transform_method ?? 'the client’s method'}
              </SelectItem>
              {TRANSFORM_METHODS.map((method) => (
                <SelectItem key={method} value={method} className="font-mono">
                  {method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <RuleList<UrlRewriteRule>
          {...rules('url_rewrites')}
          label="URL rewrites"
          empty="The listen path is stripped (or not) and the rest joined onto the target."
          methods={false}
          extra={RewriteExtra}
        />
      </Part>
    </section>
  );
}

/**
 * A version's name. Renaming commits on blur (or Enter), and only a name
 * g2way accepts that no other version has, so keys never collide mid-typing.
 */
function VersionName({
  id,
  name,
  cfg,
  problem,
  isDefault,
  onRename,
}: {
  id: string;
  name: string;
  cfg: VersioningConfig;
  problem?: string;
  isDefault: boolean;
  onRename: (to: string) => void;
}) {
  const [text, setText] = useState(name);
  const typed = renameProblem(cfg, name, text);
  const commit = () => {
    if (typed === undefined && text !== name) onRename(text);
  };
  return (
    <Field
      id={id}
      label={isDefault ? 'Version (the default)' : 'Version'}
      help="What clients send to select it."
      problem={typed ?? problem}
    >
      <Input
        id={id}
        className="w-56 font-mono"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

/** `expires_at` as a UTC date and time; blank means the version never expires. */
function ExpiresField({
  id,
  help,
  value,
  onChange,
}: {
  id: string;
  help: string;
  value: number | null | undefined;
  onChange: (secs: number | undefined) => void;
}) {
  const parse = (text: string) => {
    const parsed = parseExpiry(text);
    return parsed.ok ? parsed.value : undefined;
  };
  const [text, setText] = useSyncedText(value ?? undefined, formatExpiry, parse);
  const parsed = parseExpiry(text);
  // Read once per mount: enough to flag a version that has already expired.
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const expired = isExpired(value, now);
  return (
    <Field
      id={id}
      label="Expires (UTC)"
      help={expired ? `Expired: requests for this version get 403. ${help}` : help}
      problem={parsed.ok ? undefined : parsed.problem}
    >
      <Input
        id={id}
        type="datetime-local"
        step={1}
        className="w-64 font-mono"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseExpiry(event.target.value);
          if (next.ok) onChange(next.value);
        }}
      />
    </Field>
  );
}
