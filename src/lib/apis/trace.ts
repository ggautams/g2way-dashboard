/**
 * The request console's **inferred** middleware trace (ADR-0011 §4).
 *
 * g2way says nothing about which layers acted on a request: its analytics
 * record has no layer field and there is no debug header (UPSTREAM.md,
 * {@link TRACE_UPSTREAM_ITEM}). So the dashboard walks the chain it already
 * models (`chainFor`, `applyVersion`) against the request it sent and the
 * response it got, and says, per slot, what most likely happened. Every
 * verdict is a reasoned guess and the UI labels it so:
 *
 * - Deterministic predictions (a blocked path, a missing credential, a body
 *   over the limit, a matching mock, a missing version) are checked against
 *   the status. One the response contradicts becomes a *mismatch*, which
 *   usually means the live route table differs from the stored definition
 *   (not reloaded) or a pattern matches differently in Rust.
 * - What the dashboard cannot see (the IP filter sees the dashboard server's
 *   address, plugins, GraphQL, gateway flags) is `unknown`; such slots are
 *   only *candidates* for a rejection nothing else explains.
 *
 * Universal and pure: the BFF computes it, and the tests pin it.
 */

import { effectiveAuth } from './auth';
import { applyVersion, chainFor, DISPATCHER_ID, FORWARDER_ID, type SlotStatus } from './chain';
import type { ApiDefinition } from './list';
import { jsRegex } from './rules';

/** The UPSTREAM.md item asking g2way for a real per-request trace. */
export const TRACE_UPSTREAM_ITEM = 'No per-request middleware trace.';

/**
 * - `rejected`: this slot most likely stopped the request.
 * - `answered`: this slot served the response itself (mock, cache, preflight).
 * - `possible`: one of several slots that could have produced the rejection.
 * - `acted`: the request passed, and this slot changed or counted it.
 * - `passed`: present, and nothing in it applied to this request.
 * - `skipped`: present, but it stands down for this request.
 * - `unknown`: present, but the dashboard cannot tell what it did.
 * - `off`: not in this API's chain.
 * - `not-reached`: after the slot that answered.
 */
export type TraceVerdict =
  | 'rejected'
  | 'answered'
  | 'possible'
  | 'acted'
  | 'passed'
  | 'skipped'
  | 'unknown'
  | 'off'
  | 'not-reached';

export type TraceStep = {
  /** A chain slot id, `DISPATCHER_ID` or `FORWARDER_ID`: link with `chainAnchor(id, version)`. */
  id: string;
  /** The version whose inner chain this step belongs to (per-version slots of a versioned API). */
  version?: string;
  title: string;
  verdict: TraceVerdict;
  detail: string;
};

/** Who produced the response, as far as the dashboard can tell. */
export type TraceOrigin = 'gateway' | 'mock' | 'cache' | 'upstream' | 'unknown';

export type Trace = {
  /** For a versioned API, the version the request resolved to (or `null`) and how. */
  version: { name: string | null; source: string } | null;
  steps: TraceStep[];
  origin: TraceOrigin;
  summary: string;
  /** Predictions the response contradicts. */
  mismatches: string[];
};

/** The request as the gateway saw it. */
export type TraceRequest = {
  method: string;
  /** The path the gateway matched, listen path included. */
  path: string;
  /** The query string, without `?`. */
  query: string;
  headers: readonly (readonly [string, string])[];
  /** Body size in bytes. */
  bodyBytes: number;
};

export type TraceResponse = {
  status: number;
  headers: readonly (readonly [string, string])[];
  /** g2way's `{"error"}` message, when the body is that envelope. */
  gatewayError: string | null;
};

/** Standing caveats the console shows beside every trace. */
export const TRACE_LIMITS: readonly string[] = [
  'Inferred by the dashboard from the stored definition, the request and the response. g2way does not report which middleware acted.',
  'The gateway runs its live route table: stored changes are not live until a reload, and a stale route shows up here as a mismatch.',
  "The IP filter sees the dashboard server's address, not yours, so its verdict is unknown.",
  "Rule patterns are matched with a JavaScript translation of g2way's Rust regexes; a pattern the translation cannot follow is unknown.",
  'Plugins, GraphQL and gateway-flag slots (tracing, metrics, stats, analytics) are not modelled.',
];

// ---- helpers --------------------------------------------------------------------

type Rule = { pattern: string; methods?: string[] };

function header(headers: TraceRequest['headers'], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1] ?? null;
}

function cookie(headers: TraceRequest['headers'], name: string): boolean {
  const all = header(headers, 'cookie') ?? '';
  return all.split(';').some((pair) => pair.trim().split('=')[0] === name);
}

/** Whether `rule` applies to the request: `true`, `false`, or `null` when its pattern cannot be followed. */
function ruleMatches(rule: Rule, req: TraceRequest): boolean | null {
  const methods = rule.methods ?? [];
  if (methods.length > 0 && !methods.some((m) => m.toUpperCase() === req.method)) return false;
  const regex = jsRegex(rule.pattern);
  return regex === null ? null : regex.test(req.path);
}

type FirstMatch<R> = { index: number; rule: R } | 'unknown' | null;

/** The first rule that applies, as g2way picks it; `'unknown'` when an unfollowable pattern comes first. */
function firstMatch<R extends Rule>(
  rules: readonly R[] | null | undefined,
  req: TraceRequest,
): FirstMatch<R> {
  for (const [index, rule] of (rules ?? []).entries()) {
    const matched = ruleMatches(rule, req);
    if (matched === null) return 'unknown';
    if (matched) return { index, rule };
  }
  return null;
}

const describeRule = (list: string, index: number, rule: Rule) =>
  `${list}[${index}] (${rule.pattern}${rule.methods?.length ? ` ${rule.methods.join(',')}` : ''})`;

const oneOf = (statuses: readonly number[]) => (status: number) => statuses.includes(status);
const any4xx = (status: number) => status >= 400 && status < 500;
const anyError = (status: number) => status >= 400;

/**
 * What one step expects. `expect` is a deterministic prediction: if the
 * request reaches this step, it stops here with a status passing `test`.
 * `could` marks an uncertain step as a candidate for an otherwise unexplained
 * gateway rejection with that status.
 */
type Plan = {
  step: TraceStep;
  expect?: { kind: 'rejected' | 'answered'; label: string; test: (status: number) => boolean };
  could?: (status: number) => boolean;
};

type Credential = { present: boolean; where: string };

/** Whether the request carries the credential `def`'s auth mode reads (never its value). */
function credentialOf(def: ApiDefinition, req: TraceRequest): Credential | null {
  const auth = effectiveAuth(def);
  const authorization = header(req.headers, 'authorization') ?? '';
  switch (auth.mode) {
    case 'keyless':
      return null;
    case 'auth_token': {
      const name = auth.header ?? 'Authorization';
      const places = [`the ${name} header`];
      let present = header(req.headers, name) !== null;
      if (auth.query_param) {
        places.push(`the ${auth.query_param} query parameter`);
        present ||= new URLSearchParams(req.query).has(auth.query_param);
      }
      if (auth.cookie) {
        places.push(`the ${auth.cookie} cookie`);
        present ||= cookie(req.headers, auth.cookie);
      }
      return { present, where: places.join(' or ') };
    }
    case 'jwt':
    case 'oidc': {
      const name = auth.header ?? 'Authorization';
      return { present: header(req.headers, name) !== null, where: `the ${name} header` };
    }
    case 'hmac':
      return {
        present: /^signature\s/i.test(authorization),
        where: 'an Authorization: Signature … header',
      };
    case 'basic_auth':
      return {
        present: /^basic\s/i.test(authorization),
        where: 'an Authorization: Basic … header',
      };
    case 'mtls':
      return { present: false, where: 'a client certificate, which the console cannot present' };
  }
}

function rateHeaders(res: TraceResponse): string {
  const shown = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']
    .map((name) => [name, header(res.headers, name)] as const)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${value}`);
  return shown.length > 0 ? ` Response: ${shown.join(', ')}.` : '';
}

type Selected =
  | { ok: true; name: string; source: string }
  | { ok: false; name: string | null; source: string; why: string; test: (s: number) => boolean };

/** Which version the dispatcher picks for `req` (versioning.rs), or why it refuses. */
function selectVersion(def: ApiDefinition, req: TraceRequest, nowSecs: number): Selected | null {
  const chain = chainFor(def);
  if (!chain.versioned) return null;
  const { location, key, defaultVersion } = chain.selector;
  const asked =
    location === 'query_param' ? new URLSearchParams(req.query).get(key) : header(req.headers, key);
  const where = location === 'query_param' ? `query parameter ${key}` : `header ${key}`;
  const name = asked ?? defaultVersion;
  const source = asked !== null ? `from the ${where}` : 'the default version';
  if (name === null) {
    return {
      ok: false,
      name: null,
      source: `no ${where}`,
      why: `No ${where} and no default version: rejected with 403.`,
      test: oneOf([403]),
    };
  }
  const version = chain.versions.find((v) => v.name === name);
  if (version === undefined) {
    return {
      ok: false,
      name,
      source,
      why: `No version "${name}" is configured: the dispatcher refuses it.`,
      test: any4xx,
    };
  }
  if (version.expiresAt !== null && nowSecs >= version.expiresAt) {
    return {
      ok: false,
      name,
      source,
      why: `Version "${name}" expired at ${new Date(version.expiresAt * 1000).toISOString()}: rejected with 403.`,
      test: oneOf([403]),
    };
  }
  return { ok: true, name, source };
}

// ---- per-slot plans --------------------------------------------------------------

type Context = {
  def: ApiDefinition;
  req: TraceRequest;
  res: TraceResponse;
  /** Set by the path policy: does an ignore_auth_paths rule match? */
  ignored: boolean | null;
};

function planSlot(status: SlotStatus, ctx: Context, version: string | undefined): Plan {
  const { slot, state, reason } = status;
  const { def, req, res } = ctx;
  const step = (verdict: TraceVerdict, detail: string): TraceStep => ({
    id: slot.id,
    ...(version !== undefined && slot.scope === 'per-version' ? { version } : {}),
    title: slot.title,
    verdict,
    detail,
  });
  if (state === 'off') return { step: step('off', reason) };
  if (state === 'unreached') return { step: step('not-reached', reason) };
  if (state === 'gateway') return { step: step('unknown', reason) };

  switch (slot.id) {
    case 'set-context':
      return { step: step('acted', 'Stamps the API id and org id on the request.') };
    case 'ip-filter':
      return {
        step: step(
          'unknown',
          "allow_ips/block_ips are checked against the peer address, which is the dashboard server's, not yours.",
        ),
        could: oneOf([403]),
      };
    case 'cors': {
      const origin = header(req.headers, 'origin');
      if (origin === null)
        return { step: step('passed', 'No Origin header: nothing to decorate.') };
      const preflight =
        req.method === 'OPTIONS' && header(req.headers, 'access-control-request-method') !== null;
      const allowed = header(res.headers, 'access-control-allow-origin');
      if (preflight && def.cors?.options_passthrough !== true) {
        return {
          step: step('acted', 'A preflight: answered by the gateway.'),
          expect: {
            kind: 'answered',
            label: 'the gateway answers the preflight',
            test: (s) => s < 300,
          },
        };
      }
      return {
        step: step(
          allowed !== null ? 'acted' : 'passed',
          allowed !== null
            ? `Decorated the response: access-control-allow-origin: ${allowed}.`
            : `Origin ${origin} got no access-control-allow-origin: not in allowed_origins?`,
        ),
      };
    }
    case 'path-policy': {
      const blocked = firstMatch(def.block_paths, req);
      if (blocked === 'unknown') {
        return {
          step: step('unknown', 'A block_paths pattern cannot be followed here.'),
          could: oneOf([403]),
        };
      }
      if (blocked !== null) {
        return {
          step: step(
            'passed',
            `Matches ${describeRule('block_paths', blocked.index, blocked.rule)}.`,
          ),
          expect: { kind: 'rejected', label: 'blocked path → 403', test: oneOf([403]) },
        };
      }
      const ignored = firstMatch(def.ignore_auth_paths, req);
      ctx.ignored = ignored === 'unknown' ? null : ignored !== null;
      const ignoreNote =
        ignored === 'unknown'
          ? ' An ignore_auth_paths pattern cannot be followed here.'
          : ignored !== null
            ? ` Matches ${describeRule('ignore_auth_paths', ignored.index, ignored.rule)}: auth stands down.`
            : '';
      if ((def.allow_paths ?? []).length > 0) {
        const allowed = firstMatch(def.allow_paths, req);
        if (allowed === 'unknown') {
          return {
            step: step('unknown', `An allow_paths pattern cannot be followed here.${ignoreNote}`),
            could: oneOf([403]),
          };
        }
        if (allowed === null) {
          return {
            step: step('passed', `Matches no allow_paths rule.${ignoreNote}`),
            expect: { kind: 'rejected', label: 'not an allowed path → 403', test: oneOf([403]) },
          };
        }
        return {
          step: step(
            ignored !== null && ignored !== 'unknown' ? 'acted' : 'passed',
            `Allowed by ${describeRule('allow_paths', allowed.index, allowed.rule)}.${ignoreNote}`,
          ),
        };
      }
      return {
        step: step(
          ignored !== null && ignored !== 'unknown' ? 'acted' : 'passed',
          `No block rule matches.${ignoreNote}`,
        ),
      };
    }
    case 'size-limit': {
      const max = def.max_request_body_bytes ?? Infinity;
      return req.bodyBytes > max
        ? {
            step: step('passed', `The body is ${req.bodyBytes} bytes, over the ${max}-byte limit.`),
            expect: { kind: 'rejected', label: 'body over the limit → 413', test: oneOf([413]) },
          }
        : { step: step('passed', `The body is ${req.bodyBytes} bytes, within ${max}.`) };
    }
    case 'plugins-pre':
    case 'plugins-post':
      return {
        step: step('unknown', 'WASM plugins can change or answer any request; not modelled.'),
        could: anyError,
      };
    case 'auth': {
      if (ctx.ignored === true) {
        return {
          step: step('skipped', 'An ignore_auth_paths rule matches: no credential needed.'),
        };
      }
      const credential = credentialOf(def, req);
      const mode = effectiveAuth(def).mode;
      if (credential === null) return { step: step('off', 'Keyless API.') };
      const hedge = ctx.ignored === null ? ' (unless an ignore_auth_paths rule matches)' : '';
      if (!credential.present) {
        return {
          step: step('passed', `${mode}: no credential in ${credential.where}${hedge}.`),
          expect: {
            kind: 'rejected',
            label: 'missing credential → 401/403',
            test: oneOf([401, 403]),
          },
        };
      }
      return {
        step: step(
          'passed',
          `${mode}: a credential is present in ${credential.where}; whether it is valid only the gateway knows.`,
        ),
        could: oneOf([401, 403]),
      };
    }
    case 'rate-limit': {
      const parts: string[] = [];
      let acted = false;
      const endpoint = firstMatch(def.endpoint_rate_limits, req);
      if (endpoint === 'unknown')
        parts.push('An endpoint_rate_limits pattern cannot be followed here.');
      else if (endpoint !== null) {
        acted = true;
        const { requests, per_seconds } = endpoint.rule.rate;
        parts.push(
          `Counted against ${describeRule('endpoint_rate_limits', endpoint.index, endpoint.rule)}: ${requests} per ${per_seconds} s, all clients combined.`,
        );
      }
      const keyless = effectiveAuth(def).mode === 'keyless';
      if (!keyless && ctx.ignored !== true) {
        acted = true;
        parts.push("The session's rate and quota apply once the credential resolves.");
      }
      if (parts.length === 0) parts.push('No limit applies to this request.');
      return {
        step: step(acted ? 'acted' : 'passed', `${parts.join(' ')}${rateHeaders(res)}`),
        could: oneOf([429]),
      };
    }
    case 'graphql':
      return {
        step: step(
          'unknown',
          `${reason} Schema validation, depth and field grants are not modelled.`,
        ),
        could: oneOf([400, 403, 413]),
      };
    case 'transform-headers': {
      const t = def.transform_headers ?? {};
      const names = (side: 'request' | 'response') => {
        const add = Object.keys(t[side]?.add ?? {});
        const remove = t[side]?.remove ?? [];
        return [
          ...(add.length ? [`adds ${add.join(', ')}`] : []),
          ...(remove.length ? [`removes ${remove.join(', ')}`] : []),
        ].join('; ');
      };
      const request = names('request');
      const response = names('response');
      const seen = Object.keys(t.response?.add ?? {}).filter(
        (name) => header(res.headers, name) !== null,
      );
      const parts = [
        request && `Request: ${request}.`,
        response && `Response: ${response}.`,
        seen.length && `Seen on the response: ${seen.join(', ')}.`,
      ].filter(Boolean);
      return { step: step('acted', parts.join(' ') || 'No header rules.') };
    }
    case 'transform-body': {
      const body = def.transform_body;
      const request = firstMatch(body?.request, req);
      const response = firstMatch(body?.response, req);
      const say = (side: string, match: FirstMatch<Rule>) =>
        match === 'unknown'
          ? `${side}: a pattern cannot be followed here.`
          : match === null
            ? `${side}: no rule matches.`
            : `${side}: rewritten by ${describeRule(`transform_body.${side.toLowerCase()}`, match.index, match.rule)}.`;
      const acts =
        (request !== null && request !== 'unknown') ||
        (response !== null && response !== 'unknown');
      return {
        step: step(
          acts ? 'acted' : 'passed',
          `${say('Request', request)} ${say('Response', response)}`,
        ),
        could: oneOf([413, 502]),
      };
    }
    case 'mock': {
      const mock = firstMatch(def.mock_responses, req);
      if (mock === 'unknown') {
        return { step: step('unknown', 'A mock_responses pattern cannot be followed here.') };
      }
      if (mock === null) return { step: step('passed', 'No mock matches.') };
      const status = mock.rule.status ?? 200;
      return {
        step: step('passed', `Matches ${describeRule('mock_responses', mock.index, mock.rule)}.`),
        expect: { kind: 'answered', label: `mock → ${status}`, test: oneOf([status]) },
      };
    }
    case 'cache': {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return { step: step('skipped', `${req.method} is never cached.`) };
      }
      const flag = header(res.headers, 'x-g2-cache');
      if (flag?.toLowerCase() === 'hit') {
        return {
          step: step('passed', 'x-g2-cache: hit.'),
          expect: { kind: 'answered', label: 'cache hit', test: () => true },
        };
      }
      return {
        step: step(
          'passed',
          'Not a cache hit. A 2xx without Set-Cookie may have been stored for the next request.',
        ),
      };
    }
    case 'api-id-header':
      return { step: step('acted', 'Sets x-g2-api-id on the upstream-bound request.') };
    default:
      return { step: step('unknown', reason) };
  }
}

function planForwarder(def: ApiDefinition, req: TraceRequest, version: string | undefined): Plan {
  const chain = chainFor(def);
  const forwarder = chain.versioned ? null : chain.forwarder;
  const notes: string[] = [];
  const rewrite = firstMatch(def.url_rewrites, req);
  if (rewrite === 'unknown') notes.push('A url_rewrites pattern cannot be followed here.');
  else if (rewrite !== null) {
    notes.push(
      `Upstream path from ${describeRule('url_rewrites', rewrite.index, rewrite.rule)} → ${rewrite.rule.rewrite}.`,
    );
  } else if (def.strip_listen_path !== false) {
    const base = def.listen_path.replace(/\/+$/, '');
    notes.push(`Upstream path: ${req.path.slice(base.length) || '/'} (listen path stripped).`);
  } else {
    notes.push(`Upstream path: ${req.path} (listen path kept).`);
  }
  if (def.transform_method) notes.push(`Sent upstream as ${def.transform_method}.`);
  const target =
    forwarder?.target ??
    (def.target_list?.length ? `${def.target_list.length} targets` : def.target_url);
  return {
    step: {
      id: FORWARDER_ID,
      ...(version !== undefined ? { version } : {}),
      title: 'Forwarder',
      verdict: 'acted',
      detail: `To ${target}. ${notes.join(' ')}`,
    },
    // Upstream unreachable or timed out, or the circuit breaker is open.
    could: oneOf([502, 503, 504]),
  };
}

// ---- the trace -------------------------------------------------------------------

/**
 * The inferred trace for one console request against `def` (the stored
 * definition, secrets and all: nothing here echoes a header value or secret).
 */
export function inferTrace(
  def: ApiDefinition,
  req: TraceRequest,
  res: TraceResponse,
  nowSecs: number = Math.floor(Date.now() / 1000),
): Trace {
  const request = { ...req, method: req.method.toUpperCase() };
  const chain = chainFor(def);
  const plans: Plan[] = [];
  let version: Trace['version'] = null;
  let effective = def;
  let versionName: string | undefined;

  const outer = chain.versioned ? chain.outer : chain.slots;
  const ctx: Context = { def, req: request, res, ignored: false };
  for (const status of outer) plans.push(planSlot(status, ctx, undefined));

  if (chain.versioned) {
    const selected = selectVersion(def, request, nowSecs);
    if (selected !== null && !selected.ok) {
      version = { name: selected.name, source: selected.source };
      plans.push({
        step: {
          id: DISPATCHER_ID,
          title: 'Version dispatcher',
          verdict: 'passed',
          detail: selected.why,
        },
        expect: { kind: 'rejected', label: selected.why, test: selected.test },
      });
    } else if (selected !== null) {
      version = { name: selected.name, source: selected.source };
      versionName = selected.name;
      const overrides = def.versioning?.versions[selected.name] ?? {};
      effective = applyVersion(def, overrides);
      plans.push({
        step: {
          id: DISPATCHER_ID,
          title: 'Version dispatcher',
          verdict: 'acted',
          detail: `Routed to version ${selected.name} (${selected.source}).`,
        },
      });
      const inner = chain.versions.find((v) => v.name === selected.name)?.inner ?? [];
      const innerCtx: Context = { def: effective, req: request, res, ignored: false };
      for (const status of inner) plans.push(planSlot(status, innerCtx, versionName));
    }
  }
  if (!chain.versioned || versionName !== undefined) {
    plans.push(planForwarder(effective, request, versionName));
  }

  return { version, ...reconcile(plans, res) };
}

/** Matches the plans against the response: where it stopped, and what that means. */
function reconcile(plans: Plan[], res: TraceResponse): Omit<Trace, 'version'> {
  const { status } = res;
  const mismatches: string[] = [];
  const gatewayish = res.gatewayError !== null || status === 429;
  let stop: { at: number; verdict: 'rejected' | 'answered' | 'possible'; also: number[] } | null =
    null;

  const candidatesUpTo = (end: number) =>
    plans
      .slice(0, end)
      .map((plan, index) => ({ plan, index }))
      .filter(({ plan }) => plan.could?.(status) === true)
      .map(({ index }) => index);

  /** Candidates for an unexplained rejection must come before this plan. */
  let limit = plans.length;
  for (const [index, plan] of plans.entries()) {
    if (plan.expect === undefined) continue;
    if (plan.expect.test(status)) {
      stop = { at: index, verdict: plan.expect.kind, also: [] };
      break;
    }
    // An earlier, uncertain slot may have answered first, which would explain the miss.
    if (gatewayish && candidatesUpTo(index).length > 0) {
      limit = index;
      break;
    }
    mismatches.push(
      `${plan.step.title}: expected ${plan.expect.label}, but the response was ${status}.`,
    );
  }

  if (stop === null && gatewayish) {
    const candidates = candidatesUpTo(limit);
    if (candidates.length === 1)
      stop = { at: candidates[0] as number, verdict: 'rejected', also: [] };
    else if (candidates.length > 1) {
      stop = {
        at: candidates[candidates.length - 1] as number,
        verdict: 'possible',
        also: candidates,
      };
    }
  }

  const steps = plans.map(({ step }, index) => {
    if (stop === null) return step;
    if (stop.verdict === 'possible' && stop.also.includes(index)) {
      return { ...step, verdict: 'possible' as const };
    }
    if (index === stop.at) {
      return {
        ...step,
        verdict: stop.verdict,
        detail: `${step.detail}${likely(plans[index], stop)}`,
      };
    }
    if (index > stop.at && step.verdict !== 'off') {
      return { ...step, verdict: 'not-reached' as const };
    }
    return step;
  });

  const { origin, summary } = describe(steps, stop, res);
  return { steps, origin, summary, mismatches };
}

function likely(plan: Plan | undefined, stop: { verdict: string }): string {
  if (plan?.expect !== undefined || stop.verdict !== 'rejected') return '';
  return ' Most likely rejected here: no other slot explains the response.';
}

function describe(
  steps: TraceStep[],
  stop: { at: number; verdict: string; also: number[] } | null,
  res: TraceResponse,
): { origin: TraceOrigin; summary: string } {
  const quoted = res.gatewayError !== null ? ` ("${res.gatewayError}")` : '';
  if (stop === null) {
    if (res.gatewayError !== null) {
      return {
        origin: 'unknown',
        summary: `A ${res.status} in g2way's error envelope${quoted} that no modelled slot explains: the live definition may differ from the stored one.`,
      };
    }
    return {
      origin: 'upstream',
      summary: `Reached the forwarder: the ${res.status} most likely came from the upstream.`,
    };
  }
  const step = steps[stop.at] as TraceStep;
  if (stop.verdict === 'possible') {
    const names = stop.also.map((i) => steps[i]?.title).join(', ');
    return {
      origin: 'gateway',
      summary: `A ${res.status}${quoted} that one of these could have produced: ${names}.`,
    };
  }
  if (step.id === 'mock') return { origin: 'mock', summary: 'Answered by a mock response.' };
  if (step.id === 'cache') return { origin: 'cache', summary: 'Served from the response cache.' };
  if (step.id === FORWARDER_ID) {
    return {
      origin: 'gateway',
      summary: `The forwarder answered ${res.status}${quoted}: upstream unreachable or timed out, or the circuit is open.`,
    };
  }
  if (stop.verdict === 'answered') {
    return { origin: 'gateway', summary: `Answered by the gateway at ${step.title}.` };
  }
  return { origin: 'gateway', summary: `Rejected by ${step.title} with ${res.status}${quoted}.` };
}
