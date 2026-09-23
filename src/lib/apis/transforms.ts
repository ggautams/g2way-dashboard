/**
 * The API designer's traffic-transform and CORS model: `transform_headers`,
 * `transform_body` and `cors`. The checks mirror `HeaderTransforms::validate`
 * (`crates/g2-core/src/transform.rs`), `BodyTransforms::validate` and
 * `BodyTransformRule::validate` (`body_transform.rs`) and
 * `CorsConfig::validate` (`security.rs`). Universal and pure: the client
 * editors and the tests share it.
 *
 * Header and body transforms are also `VersionOverrides` fields, replaced
 * wholesale per version (absent inherits). So every problem function takes
 * the prefix its keys go under: the field name on the base definition, or a
 * per-version prefix in 2d's overrides.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import { containsMask } from '@/lib/secrets/redact';
import type { ApiDefinition } from './list';
import {
  HOP_BY_HOP,
  isHeaderName,
  isHeaderValue,
  methodsProblem,
  regexProblem,
  starterPattern,
  type RuleProblems,
  type RuleProp,
} from './rules';

type Schemas = components['schemas'];
export type HeaderTransform = Schemas['HeaderTransform'];
export type HeaderTransforms = Schemas['HeaderTransforms'];
export type BodyTransformRule = Schemas['BodyTransformRule'];
export type BodyTransforms = Schemas['BodyTransforms'];
export type CorsConfig = Schemas['CorsConfig'];

export const DIRECTIONS = ['request', 'response'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** g2way's serde default for `BodyTransformRule::content_type`. */
export const BODY_DEFAULT_CONTENT_TYPE = 'application/json';
/** `DEFAULT_MAX_RESPONSE_BODY_BYTES` (body_transform.rs): 1 MiB. */
export const BODY_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
/** `DEFAULT_CORS_METHODS` (security.rs): what an absent `allowed_methods` means. */
export const CORS_DEFAULT_METHODS = ['GET', 'HEAD', 'POST'] as const;

/** The template variables a body rule sees (vendored `body-transforms.md`). */
export const TEMPLATE_VARIABLES: readonly (readonly [name: string, meaning: string])[] = [
  ['body', 'the payload parsed as JSON; none when it does not parse'],
  ['raw', 'the payload as text, always present'],
  ['_g2.method', 'the client request method'],
  ['_g2.path', 'the full client request path'],
  ['_g2.query', 'the raw query string'],
  ['_g2.headers', 'request headers, lowercase name to first value'],
  ['_g2.session', '{ alias } when authenticated, none otherwise'],
  ['_g2.status', 'response rules only: the upstream status'],
];

type Problems<K extends string> = Partial<Record<K, string>>;

// ---- header transforms -----------------------------------------------------------

export type HeaderSetting = 'add' | 'remove';
/** A header-transform problem's key under its prefix: `request.add`, `response.remove`, … */
export type HeaderProblemKey = `${Direction}.${HeaderSetting}`;

function isEmptyHeaderTransform(t: HeaderTransform | undefined): boolean {
  return Object.keys(t?.add ?? {}).length === 0 && (t?.remove ?? []).length === 0;
}

/**
 * `transforms` with one direction replaced, empty directions dropped (g2way
 * skips serialising them). With nothing left, the base definition drops the
 * block (`undefined`); a version override (`keepEmpty`) keeps `{}`, since
 * absent there would mean "inherit".
 */
export function withHeaderTransform(
  transforms: HeaderTransforms | null | undefined,
  direction: Direction,
  transform: HeaderTransform,
  keepEmpty = false,
): HeaderTransforms | undefined {
  const next: HeaderTransforms = { ...(transforms ?? {}) };
  const tidy: HeaderTransform = {};
  if (Object.keys(transform.add ?? {}).length > 0) tidy.add = transform.add;
  if ((transform.remove ?? []).length > 0) tidy.remove = transform.remove;
  if (isEmptyHeaderTransform(tidy)) delete next[direction];
  else next[direction] = tidy;
  return next.request === undefined && next.response === undefined && !keepEmpty ? undefined : next;
}

/**
 * An `add` map split for editing (ADR-0010): `open` holds the values the
 * role can see, `hidden` the names whose value arrived as the mask. The
 * editor shows only `open` as text; `hidden` stays read-only.
 */
export function splitMasked(add: Record<string, string> | undefined): {
  open: Record<string, string> | undefined;
  hidden: string[];
} {
  const open: Record<string, string> = {};
  const hidden: string[] = [];
  for (const [name, value] of Object.entries(add ?? {})) {
    if (containsMask(value)) hidden.push(name);
    else open[name] = value;
  }
  return { open: Object.keys(open).length > 0 ? open : undefined, hidden };
}

/**
 * The edited `open` headers joined back with the hidden ones still in
 * `previous` (a hidden header typed again is replaced by what was typed).
 * The hidden values still carry the mask, so `headerTransformProblems`
 * refuses the save until each is removed or retyped.
 */
export function mergeMasked(
  open: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  hidden: readonly string[],
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(open ?? {}) };
  for (const name of hidden) {
    const value = previous?.[name];
    if (value !== undefined && !(name in next)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** `add` without `name`; none left is `undefined`. */
export function withoutHeader(
  add: Record<string, string> | undefined,
  name: string,
): Record<string, string> | undefined {
  const next = { ...(add ?? {}) };
  delete next[name];
  return Object.keys(next).length > 0 ? next : undefined;
}

/** `HeaderTransforms::validate`, keyed `<prefix>.<direction>.<add|remove>`. */
export function headerTransformProblems<P extends string>(
  transforms: HeaderTransforms | null | undefined,
  prefix: P,
): Problems<`${P}.${HeaderProblemKey}`> {
  const problems: Problems<`${P}.${HeaderProblemKey}`> = {};
  for (const direction of DIRECTIONS) {
    const t = transforms?.[direction];
    for (const [name, value] of Object.entries(t?.add ?? {})) {
      let problem: string | undefined;
      if (!isHeaderName(name)) problem = `Not a valid header name: ${name}`;
      else if ((HOP_BY_HOP as readonly string[]).includes(name.toLowerCase())) {
        problem = `Must not set the hop-by-hop header ${name} (removing it is fine).`;
      } else if (!isHeaderValue(value)) {
        problem = `The value for ${name} is not a valid header value.`;
      } else if (containsMask(value)) {
        problem = `The value for ${name} is hidden from your role; remove it or type a new value.`;
      }
      if (problem !== undefined) {
        problems[`${prefix}.${direction}.add`] = problem;
        break;
      }
    }
    const bad = (t?.remove ?? []).find((name) => !isHeaderName(name));
    if (bad !== undefined)
      problems[`${prefix}.${direction}.remove`] = `Not a valid header name: ${bad}`;
  }
  return problems;
}

// ---- body transforms -------------------------------------------------------------

/** A block-level body problem: the block itself (no rules) or its response cap. */
export type BodyProblemKey =
  '' | '.max_response_body_bytes' | `.${Direction}.${number}.${RuleProp}`;

/** A new body rule: anchored under the listen path, passing the raw payload through as JSON. */
export function newBodyRule(listenPath: string): BodyTransformRule {
  return { pattern: starterPattern(listenPath), template: '{{ body | tojson }}' };
}

/**
 * `block` with one direction's rules replaced; an empty list is dropped (g2way
 * skips serialising it). A base block with no rules and no cap is dropped
 * whole (`undefined`), since g2way refuses a present block with no rules; a
 * version override (`keepEmpty`) keeps it, and the problem shows instead.
 */
export function withBodyRules(
  block: BodyTransforms | null | undefined,
  direction: Direction,
  rules: BodyTransformRule[] | undefined,
  keepEmpty = false,
): BodyTransforms | undefined {
  const next: BodyTransforms = { ...(block ?? {}) };
  if (rules === undefined || rules.length === 0) delete next[direction];
  else next[direction] = rules;
  return Object.keys(next).length === 0 && !keepEmpty ? undefined : next;
}

/** `block` with its response cap set; `undefined` is g2way's 1 MiB default. */
export function withMaxResponseBytes(
  block: BodyTransforms | null | undefined,
  bytes: number | undefined,
  keepEmpty = false,
): BodyTransforms | undefined {
  const next: BodyTransforms = { ...(block ?? {}) };
  if (bytes === undefined) delete next.max_response_body_bytes;
  else next.max_response_body_bytes = bytes;
  return Object.keys(next).length === 0 && !keepEmpty ? undefined : next;
}

/** minijinja block tags and what closes them. `set` is a block only without `=`. */
const JINJA_BLOCKS: Readonly<Record<string, string>> = {
  if: 'endif',
  for: 'endfor',
  block: 'endblock',
  macro: 'endmacro',
  call: 'endcall',
  filter: 'endfilter',
  with: 'endwith',
  autoescape: 'endautoescape',
  set: 'endset',
};
const JINJA_CLOSE: Readonly<Record<string, string>> = { '{{': '}}', '{%': '%}', '{#': '#}' };
const JINJA_MIDDLE: Readonly<Record<string, readonly string[]>> = {
  elif: ['if'],
  else: ['if', 'for'],
};

/**
 * Why minijinja would refuse `template`'s syntax, or `undefined` when the
 * browser cannot tell. A best effort, like `regexProblem`: it checks the
 * delimiters close, strings inside tags close, and block tags pair up
 * (`raw` bodies are skipped). Expression syntax is not parsed; the gateway
 * checks the template on save and its message is shown verbatim.
 */
export function templateProblem(template: string): string | undefined {
  const stack: string[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.slice(i, i + 2);
    const close = JINJA_CLOSE[open];
    if (close === undefined) {
      i++;
      continue;
    }
    // Scan to the closing delimiter, skipping quoted strings (not in comments).
    let j = i + 2;
    let quote: string | null = null;
    let end = -1;
    while (j < template.length) {
      const ch = template[j] as string;
      if (quote !== null) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
      } else if (open !== '{#' && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (template.startsWith(close, j)) {
        end = j;
        break;
      }
      j++;
    }
    const line = template.slice(0, i).split('\n').length;
    if (end === -1) {
      return quote !== null
        ? `Unclosed string in the tag opened on line ${line}.`
        : `Unclosed ${open} … ${close} opened on line ${line}.`;
    }
    if (open === '{%') {
      const body = template
        .slice(i + 2, end)
        .replace(/^[-+]/, '')
        .replace(/[-+]$/, '')
        .trim();
      const word = /^[A-Za-z_]+/.exec(body)?.[0] ?? '';
      if (word === '') return `Empty {% %} tag on line ${line}.`;
      if (word === 'raw') {
        const endRaw = /\{%[-+]?\s*endraw\s*[-+]?%\}/.exec(template.slice(end + 2));
        if (endRaw === null) return `{% raw %} on line ${line} is never closed with {% endraw %}.`;
        i = end + 2 + endRaw.index + endRaw[0].length;
        continue;
      }
      const opens = JINJA_BLOCKS[word];
      if (opens !== undefined && !(word === 'set' && body.includes('='))) {
        stack.push(word);
      } else if (word.startsWith('end')) {
        const top = stack.pop();
        if (top === undefined) return `{% ${word} %} on line ${line} closes nothing.`;
        if (JINJA_BLOCKS[top] !== word) {
          return `{% ${word} %} on line ${line} closes a {% ${top} %} (expected {% ${JINJA_BLOCKS[top]} %}).`;
        }
      } else if (JINJA_MIDDLE[word] !== undefined) {
        const top = stack.at(-1);
        if (top === undefined || !JINJA_MIDDLE[word].includes(top)) {
          return `{% ${word} %} on line ${line} is outside {% ${JINJA_MIDDLE[word].join(' or ')} %}.`;
        }
      }
    }
    i = end + 2;
  }
  const open = stack.at(-1);
  return open === undefined
    ? undefined
    : `{% ${open} %} is never closed with {% ${JINJA_BLOCKS[open]} %}.`;
}

/** `BodyTransformRule::validate`, as the rule editor reads problems. */
export function bodyRuleProblems(rule: BodyTransformRule): RuleProblems {
  const problems: RuleProblems = {};
  const pattern = regexProblem(rule.pattern);
  if (pattern !== undefined) problems.pattern = pattern;
  const methods = methodsProblem(rule.methods);
  if (methods !== undefined) problems.methods = methods;
  if (rule.template === '') problems.template = 'The template must not be empty.';
  else {
    const template = templateProblem(rule.template);
    if (template !== undefined) problems.template = template;
  }
  if (rule.content_type !== undefined && !isHeaderValue(rule.content_type)) {
    problems.content_type = 'Not a valid header value.';
  }
  return problems;
}

/** `BodyTransforms::validate`, keyed `<prefix>`, `<prefix>.max_response_body_bytes` and `<prefix>.<direction>.<index>.<setting>`. */
export function bodyTransformProblems<P extends string>(
  block: BodyTransforms | null | undefined,
  prefix: P,
): Problems<`${P}${BodyProblemKey}`> {
  const problems: Problems<`${P}${BodyProblemKey}`> = {};
  if (block === undefined || block === null) return problems;
  if ((block.request ?? []).length === 0 && (block.response ?? []).length === 0) {
    problems[`${prefix}`] =
      'Add at least one request or response rule, or remove body transforms entirely.';
  }
  if (block.max_response_body_bytes === 0) {
    problems[`${prefix}.max_response_body_bytes`] =
      'Must be greater than zero; leave it blank for 1 MiB.';
  }
  for (const direction of DIRECTIONS) {
    (block[direction] ?? []).forEach((rule, index) => {
      for (const [prop, problem] of Object.entries(bodyRuleProblems(rule))) {
        problems[`${prefix}.${direction}.${index}.${prop as RuleProp}`] = problem;
      }
    });
  }
  return problems;
}

// ---- CORS ------------------------------------------------------------------------

export type CorsField = keyof CorsConfig;

/** The config CORS starts from: no origins yet, so the form asks for them. */
export function newCors(): CorsConfig {
  return { allowed_origins: [] };
}

/**
 * `is_valid_origin` (security.rs): `scheme://host[:port]`, http or https
 * (lower-case, as `http::Uri` normalises it), no userinfo, path or query.
 */
export function isOrigin(origin: string): boolean {
  return /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9\-._~%!$&'()*+,;=]+)(:\d{1,5})?$/.test(origin);
}

/** `CorsConfig::validate`, keyed `cors.<field>`. */
export function corsProblems(cors: CorsConfig | null | undefined): Problems<`cors.${CorsField}`> {
  const problems: Problems<`cors.${CorsField}`> = {};
  if (cors === undefined || cors === null) return problems;
  const origins = cors.allowed_origins;
  const wildcard = origins.includes('*');
  const badOrigin = origins.find((origin) => origin !== '*' && !isOrigin(origin));
  if (origins.length === 0) {
    problems['cors.allowed_origins'] = 'Add at least one origin, or * for every origin.';
  } else if (wildcard && origins.length > 1) {
    problems['cors.allowed_origins'] = 'Either * alone, or a list of explicit origins, not both.';
  } else if (badOrigin !== undefined) {
    problems['cors.allowed_origins'] =
      `Not an origin (scheme://host[:port], no path or trailing slash): ${badOrigin}`;
  }
  if (wildcard && cors.allow_credentials === true) {
    problems['cors.allow_credentials'] =
      'Credentials cannot be combined with the * origin (browsers reject it); list the origins.';
  }
  if (cors.allowed_methods !== undefined && cors.allowed_methods.length === 0) {
    problems['cors.allowed_methods'] =
      `Must not be empty; leave it unset for ${CORS_DEFAULT_METHODS.join(', ')}.`;
  } else {
    const methods = methodsProblem(cors.allowed_methods);
    if (methods !== undefined) problems['cors.allowed_methods'] = methods;
  }
  for (const field of ['allowed_headers', 'exposed_headers'] as const) {
    const bad = (cors[field] ?? []).find((name) => !isHeaderName(name));
    if (bad !== undefined) problems[`cors.${field}`] = `Not a valid header name: ${bad}`;
  }
  return problems;
}

/** Every transform and CORS problem of a definition (`draftProblems` merges them in). */
export function transformProblems(draft: ApiDefinition) {
  return {
    ...headerTransformProblems(draft.transform_headers, 'transform_headers'),
    ...bodyTransformProblems(draft.transform_body, 'transform_body'),
    ...corsProblems(draft.cors),
  };
}

// ---- help ------------------------------------------------------------------------

/**
 * Help text the transform and CORS editors show (g2way's rustdoc), read on
 * the server by `apiHelp()`: each block's introduction, and each setting's.
 */
export const TRANSFORM_HELP_KEYS = [
  'headers',
  'headers_request',
  'headers_response',
  'add',
  'remove',
  'body',
  'body_rule',
  'body_request',
  'body_response',
  'max_response_body_bytes',
  'cors',
  'allowed_origins',
  'allowed_methods',
  'allowed_headers',
  'exposed_headers',
  'allow_credentials',
  'max_age_secs',
  'options_passthrough',
] as const;
export type TransformHelp = Record<(typeof TRANSFORM_HELP_KEYS)[number], string>;
