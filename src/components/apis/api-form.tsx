'use client';

import { Field, Section, Toggle } from '@/components/designer/fields';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { effectiveAuth, TRANSFORM_METHODS, type AuthField } from '@/lib/apis/auth';
import { DISPATCHER_ID, editorAnchor, FORWARDER_ID } from '@/lib/apis/chain';
import {
  slugify,
  withAuthMode,
  withField,
  type ApiHelp,
  type DraftProblems,
} from '@/lib/apis/draft';
import { AUTH_MODES, summarise, type ApiDefinition, type AuthMode } from '@/lib/apis/list';
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
import { AuthSettings } from './auth-settings';
import { LinesField, NumberField } from './form-inputs';
import { MockExtra, RateExtra, RewriteExtra } from './rule-fields';
import { RuleList } from './rule-list';
import { BodyTransformsEditor, CorsEditor, HeaderTransformsEditor } from './transform-editors';
import { VersioningEditor } from './versioning-editor';

/** The Select's value for "no override": Radix items cannot have an empty value. */
const CLIENT_METHOD = 'client';

type Props = {
  draft: ApiDefinition;
  onChange: (draft: ApiDefinition) => void;
  /** The definition as loaded, for restoring its auth config; `null` when creating. */
  original: ApiDefinition | null;
  /** g2way's own description of each field and auth setting (`apiHelp()`). */
  help: ApiHelp;
  problems: DraftProblems;
  readOnly: boolean;
};

/**
 * The structured half of the API designer: the fields most APIs need, each
 * editing the draft in place (`withField`), so fields not shown here survive.
 * A section editing a chain slot carries `editorAnchor(slotId)` as its id, so
 * the Chain tab's "Edit" links land on it (`EDITOR_SLOTS` in chain.ts).
 */
export function ApiForm({ draft, onChange, original, help: allHelp, problems, readOnly }: Props) {
  const help = allHelp.fields;
  const creating = original === null;
  const auth = effectiveAuth(draft);
  const authProblems = Object.fromEntries(
    Object.entries(problems)
      .filter(([key]) => key.startsWith('auth.'))
      .map(([key, problem]) => [key.slice('auth.'.length), problem]),
  ) as Partial<Record<AuthField, string>>;
  const summary = summarise(draft);
  const set = <K extends keyof ApiDefinition>(key: K, value: ApiDefinition[K] | undefined) =>
    onChange(withField(draft, key, value));
  // What every rule list shares: its field, help, problems and new-rule shape.
  const rules = <L extends RuleListName>(list: L) => ({
    id: list,
    help: help[list],
    value: draft[list] as readonly RuleOf<L>[] | undefined,
    onChange: (value: RuleOf<L>[] | undefined) => set(list, value as ApiDefinition[L] | undefined),
    newRule: () => newRule(list, draft.listen_path),
    problems: problemsOf(problems, list),
    ruleHelp: allHelp.rules,
    readOnly,
  });

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
        <LinesField
          id="target_list"
          label="Load-balanced targets"
          help={help.target_list}
          problem={problems.target_list}
          value={draft.target_list}
          placeholder="One URL per line (optional)"
          onChange={(list) => set('target_list', list)}
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
      </Section>

      <Section id={editorAnchor('auth')} title="Authentication">
        <Field id="auth" label="Mode" help={allHelp.auth[auth.mode].summary || help.auth}>
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
        </Field>
        <AuthSettings
          auth={auth}
          onChange={(next) => set('auth', next)}
          original={original?.auth}
          help={allHelp.auth}
          problems={authProblems}
          readOnly={readOnly}
        />
      </Section>

      <Section id={editorAnchor('ip-filter')} title="IP filter">
        <LinesField
          id="allow_ips"
          label="Allow only"
          help={help.allow_ips}
          problem={problems.allow_ips}
          value={draft.allow_ips}
          placeholder="One IP or CIDR per line (empty: everyone)"
          onChange={(value) => set('allow_ips', value)}
        />
        <LinesField
          id="block_ips"
          label="Block"
          help={help.block_ips}
          problem={problems.block_ips}
          value={draft.block_ips}
          placeholder="One IP or CIDR per line"
          onChange={(value) => set('block_ips', value)}
        />
      </Section>

      <Section id={editorAnchor('cors')} title="CORS">
        <CorsEditor
          value={draft.cors}
          onChange={(value) => set('cors', value)}
          help={allHelp.transforms}
          problems={problems}
        />
      </Section>

      <Section id={editorAnchor('path-policy')} title="Path rules">
        <p className="text-xs text-muted md:col-span-2">
          Each pattern is a regex searched against the full client path, listen path included
          (anchor it with ^ and $). Rules are tried in order and the first match wins. A block
          always wins, then the allow list, then ignore-auth.
        </p>
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
      </Section>

      <Section id={editorAnchor('size-limit')} title="Request size limit">
        <NumberField
          id="max_request_body_bytes"
          label="Largest request body (bytes)"
          help={help.max_request_body_bytes}
          problem={problems.max_request_body_bytes}
          value={draft.max_request_body_bytes}
          min={1}
          placeholder="no limit"
          onChange={(value) => set('max_request_body_bytes', value)}
        />
      </Section>

      <Section id={editorAnchor('rate-limit')} title="Endpoint rate limits">
        <RuleList<EndpointRateLimit>
          {...rules('endpoint_rate_limits')}
          label="Limits for all clients combined"
          empty="Only each key's own rate and quota apply (set on keys and policies)."
          extra={RateExtra}
        />
      </Section>

      <Section id={editorAnchor('transform-headers')} title="Header transforms">
        <p className="text-xs text-muted md:col-span-2">
          {allHelp.transforms.headers} Values set on requests may be credentials for the upstream,
          so they are hidden from roles that cannot edit APIs.
        </p>
        <HeaderTransformsEditor
          id="transform_headers"
          value={draft.transform_headers}
          onChange={(value) => set('transform_headers', value)}
          help={allHelp.transforms}
          problems={problems}
          prefix="transform_headers"
          readOnly={readOnly}
        />
      </Section>

      <Section id={editorAnchor('transform-body')} title="Body transforms">
        <p className="text-xs text-muted md:col-span-2">
          {allHelp.transforms.body} On requests a rule&apos;s Content-Type wins over a header
          transform that sets it; on responses the header transform wins.
        </p>
        <BodyTransformsEditor
          id="transform_body"
          value={draft.transform_body}
          onChange={(value) => set('transform_body', value)}
          help={allHelp.transforms}
          ruleHelp={allHelp.rules}
          problems={problems}
          prefix="transform_body"
          listenPath={draft.listen_path}
          readOnly={readOnly}
        />
      </Section>

      <Section id={editorAnchor('mock')} title="Mock responses">
        <RuleList<MockResponse>
          {...rules('mock_responses')}
          label="Answer without the upstream"
          empty="Every request that gets this far is forwarded."
          extra={MockExtra}
        />
      </Section>

      <Section id={editorAnchor(FORWARDER_ID)} title="Upstream">
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
        <Field
          id="transform_method"
          label="Method sent upstream"
          help={help.transform_method}
          problem={problems.transform_method}
        >
          <Select
            value={draft.transform_method?.toUpperCase() ?? CLIENT_METHOD}
            onValueChange={(method) =>
              set('transform_method', method === CLIENT_METHOD ? undefined : method)
            }
            disabled={readOnly}
          >
            <SelectTrigger id="transform_method" className="w-56 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CLIENT_METHOD}>The client&apos;s method</SelectItem>
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
      </Section>

      {/* Last, though the dispatcher sits after CORS: versions override the sections above. */}
      <Section id={editorAnchor(DISPATCHER_ID)} title="Versioning">
        <VersioningEditor
          draft={draft}
          onChange={onChange}
          original={original?.versioning}
          help={allHelp}
          problems={problems}
          readOnly={readOnly}
        />
      </Section>
    </fieldset>
  );
}
