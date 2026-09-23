/**
 * The API designer's path-rule model: the six lists of regex rules an API
 * (and each version override) carries — `allow_paths`, `block_paths`,
 * `ignore_auth_paths`, `url_rewrites`, `mock_responses` and
 * `endpoint_rate_limits`. Every rule's `pattern` is a regex searched
 * (unanchored) against the full client path, listen path included; rules are
 * tried in order and the first match wins; empty `methods` means every method
 * (`crates/g2-core/src/endpoints.rs`, `transform.rs`).
 *
 * The checks mirror `PathRule::validate`, `UrlRewriteRule::validate`,
 * `MockResponse::validate` and `EndpointRateLimit::validate`. Universal and
 * pure: the client editors and the tests share it.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import { containsMask } from '@/lib/secrets/redact';
import { isTransformMethod, TRANSFORM_METHODS } from './auth';
import type { ApiDefinition } from './list';

type Schemas = components['schemas'];
export type PathRule = Schemas['PathRule'];
export type UrlRewriteRule = Schemas['UrlRewriteRule'];
export type MockResponse = Schemas['MockResponse'];
export type EndpointRateLimit = Schemas['EndpointRateLimit'];
export type RateLimit = Schemas['RateLimit'];

/** Every rule list, in chain order; each is also a `VersionOverrides` field. */
export const RULE_LISTS = [
  'block_paths',
  'allow_paths',
  'ignore_auth_paths',
  'endpoint_rate_limits',
  'mock_responses',
  'url_rewrites',
] as const satisfies readonly (keyof ApiDefinition & keyof Schemas['VersionOverrides'])[];
export type RuleList = (typeof RULE_LISTS)[number];

/** The three plain `PathRule` lists, in g2way's evaluation order (endpoints.rs). */
export const PATH_RULE_LISTS = [
  'block_paths',
  'allow_paths',
  'ignore_auth_paths',
] as const satisfies readonly RuleList[];

export type RuleOf<L extends RuleList> = NonNullable<ApiDefinition[L]>[number];

/** Any rule, including a body-transform rule (transforms.ts): all of them carry a pattern. */
export type AnyRule = RuleOf<RuleList> | Schemas['BodyTransformRule'];

/** The rule settings a problem can sit on. */
export type RuleProp =
  'pattern' | 'methods' | 'rewrite' | 'status' | 'headers' | 'rate' | 'template' | 'content_type';
export type RuleProblems = Partial<Record<RuleProp, string>>;

/** Help text for a rule's settings (g2way's rustdoc), read on the server by `apiHelp()`. */
export const RULE_HELP_KEYS = [
  'pattern',
  'methods',
  'rewrite',
  'status',
  'headers',
  'body',
  'requests',
  'per_seconds',
  'template',
  'content_type',
] as const;
export type RuleHelp = Record<(typeof RULE_HELP_KEYS)[number], string>;

/** g2way's serde default for `MockResponse::status` (`default_mock_status`), which the OpenAPI omits. */
export const MOCK_DEFAULT_STATUS = 200;

/** Headers a mock response may not set (`HOP_BY_HOP`, `transform.rs`). */
export const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const;

// ---- editing ---------------------------------------------------------------------

/** A regex matching `text` literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A new rule's pattern: everything under the listen path, anchored, so a rule
 * starts out readable (and visibly too broad) rather than as the empty regex,
 * which would silently match every path.
 */
export function starterPattern(listenPath: string): string {
  return `^${escapeRegex(listenPath)}`;
}

/** Each kind's new rule. The rate starts from the contract's example (10 per 60 s). */
export function newRule<L extends RuleList>(list: L, listenPath: string): RuleOf<L>;
export function newRule(list: RuleList, listenPath: string): AnyRule {
  const pattern = starterPattern(listenPath);
  switch (list) {
    case 'url_rewrites':
      return { pattern, rewrite: '/' };
    case 'mock_responses':
      return { pattern, status: MOCK_DEFAULT_STATUS, body: '' };
    case 'endpoint_rate_limits':
      return { pattern, rate: { requests: 10, per_seconds: 60 } };
    default:
      return { pattern };
  }
}

export function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((existing, at) => (at === index ? item : existing));
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, at) => at !== index);
}

/** `list` with the item at `index` moved one place up (`-1`) or down (`1`); order is precedence. */
export function moveBy<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to] as T, next[index] as T];
  return next;
}

/**
 * `methods` with `method` switched on or off, upper-cased, in
 * `TRANSFORM_METHODS` order. Entries the picker does not know (a problem to
 * show) are kept at the end until removed. None left is `undefined`: g2way
 * reads an absent list as "every method" and never serialises an empty one.
 */
export function toggleMethod(
  methods: readonly string[] | undefined,
  method: string,
): string[] | undefined {
  const upper = method.toUpperCase();
  const current = new Set((methods ?? []).map((m) => m.toUpperCase()));
  if (current.has(upper)) current.delete(upper);
  else current.add(upper);
  const known = TRANSFORM_METHODS.filter((m) => current.has(m));
  const unknown = [...current].filter((m) => !isTransformMethod(m));
  const next = [...known, ...unknown];
  return next.length > 0 ? next : undefined;
}

/** `rule` with its methods replaced; `undefined` removes them (every method). */
export function withMethods<R extends AnyRule>(rule: R, methods: string[] | undefined): R {
  const next: R & { methods?: string[] } = { ...rule };
  if (methods === undefined) delete next.methods;
  else next.methods = methods;
  return next;
}

/** Whether `methods` names `method`, case-insensitively as g2way matches it. */
export function hasMethod(methods: readonly string[] | undefined, method: string): boolean {
  return (methods ?? []).some((m) => m.toUpperCase() === method.toUpperCase());
}

/** A rule's methods in words; `none` (by default "every method") when empty. */
export function describeMethods(
  methods: readonly string[] | undefined,
  none = 'every method',
): string {
  return methods && methods.length > 0 ? methods.join(', ') : none;
}

/**
 * A mock's headers as `Name: value` lines. A line without `:` is a problem;
 * none is `undefined` (g2way's default: no headers).
 */
export function parseHeaderLines(
  text: string,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; problem: string } {
  const entries: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.indexOf(':');
    if (at <= 0) return { ok: false, problem: `Write each line as Name: value — ${line}` };
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { ok: true, value: entries.length > 0 ? Object.fromEntries(entries) : undefined };
}

export function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

// ---- checks ----------------------------------------------------------------------

/** What `http::HeaderName::from_bytes` accepts: an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** What `http::HeaderValue::from_str` refuses: control bytes other than tab, and DEL. */
const BAD_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;

/** Whether `http::HeaderName::from_bytes` accepts `name`. */
export function isHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}

/** Whether `http::HeaderValue::from_str` accepts `value`. */
export function isHeaderValue(value: string): boolean {
  return !BAD_HEADER_VALUE.test(value);
}

/**
 * Why g2way's regex engine would refuse `pattern`, or `undefined` when the
 * browser cannot tell. g2way compiles patterns with Rust's `regex` crate,
 * whose dialect differs from JavaScript's, so this is a best effort that
 * errs towards silence — a pattern the dashboard passes may still be
 * refused on save, and the gateway's message is then shown verbatim:
 *
 * - Look-around and backreferences compile in JavaScript but not in Rust
 *   (the crate guarantees linear-time matching); they are reported.
 * - Rust-only syntax is translated before compiling: `(?P<name>…)` named
 *   groups and inline flag groups (`(?i)`, `(?i:…)`, `(?x)`, …).
 * - What is left is compiled in JavaScript's lenient (non-`u`) mode, so a
 *   syntax error there (an unbalanced `(`, a dangling `*`) is a real one.
 *   Rust is stricter in places JavaScript is not (a bare `{` or `]`, an
 *   unknown escape such as `\q`): those pass here and fail on save.
 */
export function regexProblem(pattern: string): string | undefined {
  let source = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    const rest = pattern.slice(i);
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (!inClass && /[1-9]/.test(next)) {
        return `Backreferences (\\${next}) are not supported by g2way's regex engine.`;
      }
      if (!inClass && next === 'k' && pattern[i + 2] === '<') {
        return "Backreferences (\\k<…>) are not supported by g2way's regex engine.";
      }
      source += ch + next;
      i++;
      continue;
    }
    if (inClass) {
      // Rust nests classes (`[[:alpha:]]`, `[a-z&&[^x]]`); JavaScript cannot follow.
      if (ch === '[') return undefined;
      if (ch === ']') inClass = false;
      source += ch;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      source += ch;
      if (pattern[i + 1] === '^') source += pattern[++i];
      // A `]` straight after `[` or `[^` is a literal in both dialects.
      if (pattern[i + 1] === ']') {
        source += '\\]';
        i++;
      }
      continue;
    }
    if (/^\(\?(?:=|!|<=|<!)/.test(rest)) {
      return "Look-ahead and look-behind are not supported by g2way's regex engine.";
    }
    const named = /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
    if (named) {
      source += `(?<${named[1]}>`;
      i += named[0].length - 1;
      continue;
    }
    const flags = /^\(\?(-?[imsuxUR]+(?:-[imsuxUR]*)?)(\)|:)/.exec(rest);
    if (flags) {
      // Flags change meaning, not syntax: a group of them becomes a plain group.
      if (flags[1]?.includes('x')) return undefined; // Verbose mode: whitespace is not literal.
      source += flags[2] === ':' ? '(?:' : '';
      i += flags[0].length - 1;
      continue;
    }
    source += ch;
  }
  try {
    new RegExp(source);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Not a valid regex: ${message.replace(/^Invalid regular expression: /, '')}`;
  }
}

/** `validate_methods`: every entry a standard method, case-insensitively. */
export function methodsProblem(methods: readonly string[] | undefined): string | undefined {
  const bad = (methods ?? []).find((method) => !isTransformMethod(method));
  return bad === undefined
    ? undefined
    : `Not a standard HTTP method (${TRANSFORM_METHODS.join(', ')}): ${bad}`;
}

function headersProblem(headers: Record<string, string> | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) return `Not a valid header name: ${name}`;
    if ((HOP_BY_HOP as readonly string[]).includes(name.toLowerCase())) {
      return `A mock response must not set the hop-by-hop header ${name}.`;
    }
    if (BAD_HEADER_VALUE.test(value)) return `The value for ${name} is not a valid header value.`;
    if (containsMask(value)) {
      return `The value for ${name} is hidden from your role; it cannot be saved as shown.`;
    }
  }
  return undefined;
}

/** One rule's problems, as its kind's `validate` in g2way would find them. */
export function ruleProblems<L extends RuleList>(list: L, rule: RuleOf<L>): RuleProblems;
export function ruleProblems(list: RuleList, rule: AnyRule): RuleProblems {
  const problems: RuleProblems = {};
  const pattern = regexProblem(rule.pattern);
  if (pattern !== undefined) problems.pattern = pattern;
  if (list === 'url_rewrites') {
    if (!(rule as UrlRewriteRule).rewrite.startsWith('/')) problems.rewrite = 'Must begin with /.';
    return problems;
  }
  const methods = methodsProblem((rule as PathRule).methods);
  if (methods !== undefined) problems.methods = methods;
  if (list === 'mock_responses') {
    const mock = rule as MockResponse;
    const status = mock.status ?? MOCK_DEFAULT_STATUS;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      problems.status = 'Enter an HTTP status from 100 to 599.';
    }
    const headers = headersProblem(mock.headers);
    if (headers !== undefined) problems.headers = headers;
  }
  if (list === 'endpoint_rate_limits') {
    const { requests, per_seconds } = (rule as EndpointRateLimit).rate;
    if (!(requests >= 1 && per_seconds >= 1)) {
      problems.rate = 'Requests and seconds must both be at least 1; remove the rule for no limit.';
    }
  }
  return problems;
}

/** A rule problem's key in `DraftProblems`: `<list>.<index>.<setting>`. */
export type RuleProblemKey = `${RuleList}.${number}.${RuleProp}`;

/** Every rule problem in `rules`, keyed as {@link RuleProblemKey}. */
export function listProblems(
  list: RuleList,
  rules: readonly AnyRule[] | null | undefined,
): Partial<Record<RuleProblemKey, string>> {
  const problems: Partial<Record<RuleProblemKey, string>> = {};
  (rules ?? []).forEach((rule, index) => {
    for (const [prop, problem] of Object.entries(ruleProblems<RuleList>(list, rule))) {
      problems[`${list}.${index}.${prop as RuleProp}`] = problem;
    }
  });
  return problems;
}

/**
 * The per-rule problems of one list, back out of a flat problem map (by
 * index). `list` is the keys' prefix: a rule list's name, or e.g.
 * `transform_body.request` for body rules.
 */
export function problemsOf(
  problems: Readonly<Record<string, string | undefined>>,
  list: string,
): RuleProblems[] {
  const out: RuleProblems[] = [];
  const prefix = `${list}.`;
  for (const [key, problem] of Object.entries(problems)) {
    if (problem === undefined || !key.startsWith(prefix)) continue;
    const [index, prop] = key.slice(prefix.length).split('.');
    const at = Number(index);
    (out[at] ??= {})[prop as RuleProp] = problem;
  }
  return out;
}
