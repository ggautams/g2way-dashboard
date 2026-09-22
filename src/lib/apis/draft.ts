/**
 * The API designer's model: a draft is a whole `ApiDefinition`, and the form
 * edits it field by field through the pure helpers here. The form never
 * rebuilds a definition from its own fields, so everything it does not show
 * (CORS, transforms, plugins, …) survives an edit byte for byte. Universal:
 * the client designer and the tests share it.
 */

import type { ApiDefinition, AuthMode } from './list';

/** The fields the structured form edits; the raw editor covers the rest. */
export const FORM_FIELDS = [
  'api_id',
  'name',
  'listen_path',
  'strip_listen_path',
  'target_url',
  'target_list',
  'active',
  'auth',
  'preserve_host_header',
  'upstream_timeout_ms',
  'upstream_retries',
] as const satisfies readonly (keyof ApiDefinition)[];

export type FormField = (typeof FORM_FIELDS)[number];

/** A new API: the four required fields, empty, and active as g2way defaults it. */
export function newDraft(): ApiDefinition {
  return { api_id: '', name: '', listen_path: '/', target_url: '', active: true };
}

/**
 * `draft` with one field set. `undefined` removes an optional field, which
 * means "g2way's default" (see `docs/g2way-map.md`); required fields cannot be
 * removed, only emptied.
 */
export function withField<K extends keyof ApiDefinition>(
  draft: ApiDefinition,
  key: K,
  value: ApiDefinition[K] | undefined,
): ApiDefinition {
  const next = { ...draft };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** Fields the form does not edit that the draft carries: what "the rest" is. */
export function otherFields(draft: ApiDefinition): string[] {
  return Object.keys(draft).filter(
    (key) => key !== 'org_id' && !(FORM_FIELDS as readonly string[]).includes(key),
  );
}

type AuthConfig = NonNullable<ApiDefinition['auth']>;

/**
 * `draft` switched to auth `mode`. Returning to the mode the definition was
 * loaded with restores its full config (keys, issuers, realms); any other mode
 * starts from the smallest config g2way accepts the shape of, and its settings
 * are filled in through the raw editor. Token auth is g2way's default, so it is
 * written as no `auth` at all unless the original carried one.
 */
export function withAuthMode(
  draft: ApiDefinition,
  mode: AuthMode,
  original: ApiDefinition['auth'],
): ApiDefinition {
  if (original !== undefined && original.mode === mode) return withField(draft, 'auth', original);
  return withField(draft, 'auth', mode === 'auth_token' ? undefined : minimalAuth(mode));
}

function minimalAuth(mode: Exclude<AuthMode, 'auth_token'>): AuthConfig {
  switch (mode) {
    case 'jwt':
      return { mode, signing_method: 'rs256' };
    case 'oidc':
      return { mode, issuer_url: '', audiences: [] };
    case 'keyless':
    case 'basic_auth':
    case 'mtls':
    case 'hmac':
      return { mode };
  }
}

/** The `target_list` textarea: one URL per line; none means "use target_url". */
export function parseTargetList(text: string): string[] | undefined {
  const urls = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return urls.length > 0 ? urls : undefined;
}

/**
 * A whole-number field: blank means "g2way's default" (`undefined`); anything
 * else must be an integer within `[min, max]`, or it is a problem to show.
 */
export function parseWholeNumber(
  text: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): { ok: true; value: number | undefined } | { ok: false; problem: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      problem:
        max === Number.MAX_SAFE_INTEGER
          ? `Enter a whole number of at least ${min}.`
          : `Enter a whole number from ${min} to ${max}.`,
    };
  }
  return { ok: true, value };
}

/** A suggested `api_id` for a name: lower-case, dash-separated. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What the form can tell before the gateway does: the required fields and the
 * rules the contract states (`listen_path` starts with `/`, targets are
 * absolute http(s) URLs). The gateway's own validation is the authority; its
 * 400 message is shown verbatim on save.
 */
export function draftProblems(draft: ApiDefinition): Partial<Record<FormField, string>> {
  const problems: Partial<Record<FormField, string>> = {};
  if (draft.api_id.trim() === '') problems.api_id = 'Give the API an id.';
  else if (/[\s/?#]/.test(draft.api_id)) problems.api_id = 'No spaces, slashes, ? or #.';
  if (draft.name.trim() === '') problems.name = 'Give the API a name.';
  if (!draft.listen_path.startsWith('/')) problems.listen_path = 'Must begin with /.';
  // Required even when a target list takes over forwarding (the contract).
  if (!isHttpUrl(draft.target_url)) {
    problems.target_url = 'Enter an absolute http:// or https:// URL.';
  }
  const bad = (draft.target_list ?? []).find((url) => !isHttpUrl(url));
  if (bad !== undefined) problems.target_list = `Not an absolute http(s) URL: ${bad}`;
  return problems;
}
