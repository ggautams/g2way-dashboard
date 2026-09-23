/**
 * The API designer's auth model: every `AuthConfig` mode's settings, edited in
 * place like the rest of the draft, and the checks g2way's
 * `AuthConfig::validate` (`crates/g2-core/src/api_definition.rs`) makes, so
 * the form can say what the gateway would refuse before a save. Plus the other
 * access-side fields the form edits: IP allow/deny lists and the method
 * override. Universal and pure: the client form and the tests share it.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import { containsMask } from '@/lib/secrets/redact';
import type { ApiDefinition, AuthMode } from './list';

export type AuthConfig = components['schemas']['AuthConfig'];
export type AuthOf<M extends AuthMode> = Extract<AuthConfig, { mode: M }>;
export type HmacAlgorithm = components['schemas']['HmacAlgorithm'];
export type JwtSigningMethod = components['schemas']['JwtSigningMethod'];

type KeysOf<T> = T extends unknown ? keyof T : never;
/** Every setting any mode has, `mode` itself aside. */
export type AuthField = Exclude<KeysOf<AuthConfig>, 'mode'>;

/**
 * Each mode's settings, in the order the form shows them. `auth.test.ts`
 * keeps this in step with the contract's `AuthConfig` branches.
 */
export const AUTH_FIELDS: {
  readonly [M in AuthMode]: readonly Exclude<keyof AuthOf<M>, 'mode'>[];
} = {
  auth_token: ['header', 'query_param', 'cookie'],
  jwt: [
    'signing_method',
    'secret',
    'public_key_pem',
    'jwks_url',
    'jwks_refresh_secs',
    'header',
    'identity_claim',
  ],
  oidc: [
    'issuer_url',
    'audiences',
    'jwks_url',
    'jwks_refresh_secs',
    'header',
    'identity_claim',
    'policy_claim',
    'policy_map',
  ],
  basic_auth: ['realm'],
  hmac: ['allowed_algorithms', 'allowed_clock_skew_secs'],
  mtls: [],
  keyless: [],
};

/**
 * g2way's serde defaults for the settings, which the OpenAPI document omits
 * (`api_definition.rs`: `DEFAULT_AUTH_HEADER`, `DEFAULT_IDENTITY_CLAIM`, …).
 * Shown as placeholders: an absent setting means these.
 */
export const AUTH_DEFAULTS = {
  header: 'Authorization',
  identity_claim: 'sub',
  policy_claim: 'azp',
  realm: 'g2way',
  jwks_refresh_secs: 300,
  allowed_clock_skew_secs: 300,
} as const;

export const HMAC_ALGORITHMS = [
  'hmac-sha256',
  'hmac-sha384',
  'hmac-sha512',
] as const satisfies readonly HmacAlgorithm[];

/** What the form's help text for auth reads: each mode's summary and its settings' help. */
export type AuthHelp = {
  readonly [M in AuthMode]: { summary: string; fields: Partial<Record<AuthField, string>> };
};

/** `record` with one property set; `undefined` removes it (g2way's default). */
export function withProp<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K] | undefined,
): T {
  const next = { ...record };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** The auth config in effect: an absent `auth` is token auth with every default. */
export function effectiveAuth(draft: ApiDefinition): AuthConfig {
  return draft.auth ?? { mode: 'auth_token' };
}

/** Whether an rs256 JWT config reads its key from a JWKS URL rather than a PEM. */
export function jwtKeySource(auth: AuthOf<'jwt'>): 'pem' | 'jwks' {
  return auth.jwks_url !== undefined && auth.jwks_url !== null ? 'jwks' : 'pem';
}

const KEY_MATERIAL = ['secret', 'public_key_pem', 'jwks_url', 'jwks_refresh_secs'] as const;

function withoutKeyMaterial(auth: AuthOf<'jwt'>): AuthOf<'jwt'> {
  return KEY_MATERIAL.reduce((next, key) => withProp(next, key, undefined), auth);
}

/**
 * A JWT config switched to `method`. g2way refuses key material of the other
 * algorithm, so it is dropped; returning to the method the definition was
 * loaded with restores its key material. An hs256 config starts with an empty
 * secret, an rs256 one with an empty PEM, so the form asks for them.
 */
export function withSigningMethod(
  auth: AuthOf<'jwt'>,
  method: JwtSigningMethod,
  original: AuthConfig | undefined,
): AuthOf<'jwt'> {
  const base = { ...withoutKeyMaterial(auth), signing_method: method };
  if (original?.mode === 'jwt' && original.signing_method === method) {
    return KEY_MATERIAL.reduce((next, key) => withProp(next, key, original[key]), base);
  }
  return method === 'hs256' ? { ...base, secret: '' } : { ...base, public_key_pem: '' };
}

/** An rs256 JWT config switched to reading its key from a PEM or a JWKS URL. */
export function withJwtKeySource(auth: AuthOf<'jwt'>, source: 'pem' | 'jwks'): AuthOf<'jwt'> {
  if (jwtKeySource(auth) === source) return auth;
  const base = withoutKeyMaterial(auth);
  return source === 'pem' ? { ...base, public_key_pem: '' } : { ...base, jwks_url: '' };
}

/** HMAC's algorithm list with `algorithm` switched on or off; all three is g2way's default. */
export function withHmacAlgorithm(
  auth: AuthOf<'hmac'>,
  algorithm: HmacAlgorithm,
  on: boolean,
): AuthOf<'hmac'> {
  const current = auth.allowed_algorithms ?? HMAC_ALGORITHMS;
  const next = HMAC_ALGORITHMS.filter((a) => (a === algorithm ? on : current.includes(a)));
  return withProp(
    auth,
    'allowed_algorithms',
    next.length === HMAC_ALGORITHMS.length ? undefined : next,
  );
}

/** One entry per line, trimmed, blanks dropped; `undefined` when there are none. */
export function parseLines(text: string): string[] | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines : undefined;
}

/**
 * OIDC's `policy_map` as `client_id = policy_id` lines. A line without `=` is
 * a problem; an empty map is `undefined` (g2way's default: no mapping).
 */
export function parsePolicyMap(
  text: string,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; problem: string } {
  const entries: [string, string][] = [];
  for (const line of parseLines(text) ?? []) {
    const at = line.indexOf('=');
    if (at < 0) return { ok: false, problem: `Write each line as client_id = policy_id: ${line}` };
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { ok: true, value: entries.length > 0 ? Object.fromEntries(entries) : undefined };
}

export function formatPolicyMap(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([client, policy]) => `${client} = ${policy}`)
    .join('\n');
}

// ---- checks ----------------------------------------------------------------------

/** An RFC 9110 token: what `http::HeaderName::from_bytes` accepts. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** An absolute http(s) URL with a host. */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
  } catch {
    return false;
  }
}

const blank = (text: string | null | undefined) =>
  text !== undefined && text !== null && text.trim() === '';
const present = <T>(value: T | null | undefined): value is T =>
  value !== undefined && value !== null;

/**
 * What g2way's `AuthConfig::validate` would refuse, per setting, in its own
 * words where it has them. Also refuses a secret carrying the ADR-0010 mask,
 * which would overwrite the real one.
 */
export function authProblems(auth: AuthConfig | undefined): Partial<Record<AuthField, string>> {
  const problems: Partial<Record<AuthField, string>> = {};
  if (auth === undefined) return problems;
  const once = (field: AuthField, problem: string) => {
    problems[field] ??= problem;
  };
  if ('header' in auth && present(auth.header) && !HEADER_NAME.test(auth.header)) {
    once('header', 'Not a valid header name.');
  }
  if ('identity_claim' in auth && blank(auth.identity_claim)) {
    once('identity_claim', 'Must not be empty; leave it unset for sub.');
  }
  const checkJwks = (url: string | null | undefined, refresh: number | null | undefined) => {
    if (present(url) && !isHttpUrl(url)) once('jwks_url', 'Enter an absolute http(s) URL.');
    if (refresh === 0) once('jwks_refresh_secs', 'Must be at least 1.');
  };
  switch (auth.mode) {
    case 'auth_token':
      if (blank(auth.query_param)) once('query_param', 'Must not be empty.');
      if (blank(auth.cookie)) once('cookie', 'Must not be empty.');
      break;
    case 'jwt':
      if (present(auth.jwks_refresh_secs) && !present(auth.jwks_url)) {
        once('jwks_refresh_secs', 'Only valid alongside a JWKS URL.');
      }
      checkJwks(auth.jwks_url, auth.jwks_refresh_secs);
      if (auth.signing_method === 'hs256') {
        if (!present(auth.secret) || blank(auth.secret)) once('secret', 'hs256 needs a secret.');
        if (present(auth.public_key_pem)) once('public_key_pem', 'Not used with hs256.');
        if (present(auth.jwks_url)) once('jwks_url', 'Not used with hs256.');
      } else {
        const pem = present(auth.public_key_pem) && !blank(auth.public_key_pem);
        const jwks = present(auth.jwks_url) && !blank(auth.jwks_url);
        if (pem === jwks) {
          once(
            jwtKeySource(auth) === 'jwks' ? 'jwks_url' : 'public_key_pem',
            'rs256 needs exactly one of a PEM public key or a JWKS URL.',
          );
        }
        if (present(auth.secret)) once('secret', 'Not used with rs256.');
      }
      break;
    case 'oidc': {
      if (blank(auth.policy_claim))
        once('policy_claim', 'Must not be empty; leave it unset for azp.');
      if (
        !isHttpUrl(auth.issuer_url) ||
        auth.issuer_url.includes('?') ||
        auth.issuer_url.includes('#')
      ) {
        once('issuer_url', 'Enter an absolute http(s) URL without a query or fragment.');
      }
      if (auth.audiences.length === 0) once('audiences', 'Name at least one audience.');
      else if (auth.audiences.some((a) => a.trim() === ''))
        once('audiences', 'No blank audiences.');
      checkJwks(auth.jwks_url, auth.jwks_refresh_secs);
      const map = Object.entries(auth.policy_map ?? {});
      if (map.some(([client, policy]) => client.trim() === '' || policy.trim() === '')) {
        once('policy_map', 'Client ids and policy ids must not be empty.');
      }
      break;
    }
    case 'basic_auth':
      if (present(auth.realm)) {
        if (auth.realm.trim() === '') once('realm', 'Must not be empty; leave it unset for g2way.');
        else if (!/^[ -~]*$/.test(auth.realm) || /["\\]/.test(auth.realm)) {
          once('realm', 'Printable ASCII only, without " or \\.');
        }
      }
      break;
    case 'hmac':
      if (present(auth.allowed_algorithms)) {
        if (auth.allowed_algorithms.length === 0) once('allowed_algorithms', 'Allow at least one.');
        else if (new Set(auth.allowed_algorithms).size !== auth.allowed_algorithms.length) {
          once('allowed_algorithms', 'Must not repeat entries.');
        }
      }
      if (auth.allowed_clock_skew_secs === 0) {
        once('allowed_clock_skew_secs', 'Must be at least 1 (turn the check off instead).');
      }
      break;
    case 'mtls':
    case 'keyless':
      break;
  }
  if ('secret' in auth && present(auth.secret) && containsMask(auth.secret)) {
    problems.secret = 'This secret is hidden from your role; saving would overwrite the real one.';
  }
  return problems;
}

/** The methods g2way accepts as `transform_method` (`TRANSFORM_METHODS`, `transform.rs`). */
export const TRANSFORM_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
] as const;

export function isTransformMethod(method: string): boolean {
  return (TRANSFORM_METHODS as readonly string[]).includes(method.toUpperCase());
}

// ---- IP lists --------------------------------------------------------------------

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

function isIpv6(text: string): boolean {
  if (!text.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(text)) return false;
  try {
    new URL(`http://[${text}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * An `allow_ips`/`block_ips` entry as g2way parses it (`parse_ip_entry`,
 * `security.rs`): an IPv4 or IPv6 address, optionally with a `/prefix` no
 * longer than the address. IPv4 octets with leading zeros are refused, as
 * Rust's parser refuses them.
 */
export function isIpOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const v4 = IPV4.test(address);
  if (!v4 && !isIpv6(address)) return false;
  if (prefix === undefined) return true;
  return /^(?:0|[1-9]\d{0,2})$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128);
}
