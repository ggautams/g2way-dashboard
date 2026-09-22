/**
 * The key designer's model: a draft is a whole `KeySession`, edited field by
 * field, so everything the form does not show (`access`, `basic_auth`, `hmac`)
 * survives an edit untouched. Plus the two key response bodies the OpenAPI
 * document leaves untyped, parsed at runtime. Universal and pure.
 *
 * g2way's serde defaults (`crates/g2-core/src/session.rs`, absent from the
 * OpenAPI): `active` is `true`; an absent `rate`/`quota`/`expires_at` means
 * none; `access` is `{}`, which **grants every API in the org**; a non-empty
 * `apply_policies` (at most one entry) replaces the session's own rate, quota
 * and access at auth time.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import { PayloadShapeError } from '@/lib/g2/node';
import type { Quota, RateLimit } from '@/lib/policies/list';

export type KeySession = components['schemas']['KeySession'];

/** The fields the structured form edits; the raw editor covers the rest. */
export const KEY_FORM_FIELDS = [
  'alias',
  'active',
  'expires_at',
  'apply_policies',
  'rate',
  'quota',
] as const satisfies readonly (keyof KeySession)[];

export type KeyFormField = (typeof KEY_FORM_FIELDS)[number];

/** Help text keys: the form fields, the limits' own fields, and `access` (raw only for now). */
export type KeyHelpKey =
  | KeyFormField
  | 'access'
  | 'rate.requests'
  | 'rate.per_seconds'
  | 'quota.max'
  | 'quota.renewal_rate_secs';

// ---- the two untyped responses ----------------------------------------------

/**
 * `GET /g2/keys`: `{"keys": [hash, …]}`, sorted. The OpenAPI declares no body
 * (`content?: never`), so it is checked here and a change fails loudly.
 */
export function parseKeyList(body: unknown): string[] {
  const keys = typeof body === 'object' && body !== null && 'keys' in body ? body.keys : undefined;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) {
    throw new PayloadShapeError('GET /g2/keys', 'keys', 'an array of strings', keys);
  }
  return keys;
}

/** `POST /g2/keys` 201: the raw key, the only time it exists outside the gateway, and its hash. */
export type CreatedKey = { key: string; key_hash: string };

export function parseCreatedKey(body: unknown): CreatedKey {
  const record = typeof body === 'object' && body !== null ? body : {};
  const key = 'key' in record ? record.key : undefined;
  const hash = 'key_hash' in record ? record.key_hash : undefined;
  if (typeof key !== 'string' || key === '') {
    // A string here is empty, so quoting the value can never quote a raw key.
    throw new PayloadShapeError('POST /g2/keys', 'key', 'a non-empty string', key);
  }
  if (typeof hash !== 'string' || hash === '') {
    throw new PayloadShapeError('POST /g2/keys', 'key_hash', 'a non-empty string', hash);
  }
  return { key, key_hash: hash };
}

// ---- summaries --------------------------------------------------------------

export type KeySummary = {
  hash: string;
  alias: string | null;
  /** g2way's serde default is `true`. */
  active: boolean;
  /** Unix seconds; `null`: never expires. */
  expiresAt: number | null;
  /** The applied policy id, when there is one (at most one, `KeySession::validate`). */
  policy: string | null;
  rate: RateLimit | null;
  quota: Quota | null;
  /** The key's own `api_id`s; empty grants every API (unless a policy replaces it). */
  apis: string[];
};

export function summariseKey(hash: string, session: KeySession): KeySummary {
  return {
    hash,
    alias: session.alias ?? null,
    active: session.active ?? true,
    expiresAt: session.expires_at ?? null,
    policy: session.apply_policies?.[0] ?? null,
    rate: session.rate ?? null,
    quota: session.quota ?? null,
    apis: Object.keys(session.access ?? {}),
  };
}

/** Whether a key has expired at `nowSecs` (Unix seconds). */
export function isExpired(expiresAt: number | null, nowSecs: number): boolean {
  return expiresAt !== null && expiresAt <= nowSecs;
}

/** A hash shortened for headings: the gateway's hashes are 64 hex characters. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

// ---- paging ---------------------------------------------------------------

export type Paged<T> = { items: T[]; page: number; pages: number; total: number };

/**
 * One page of `items` (1-based `page`, clamped into range). The key list reads
 * one session per shown hash, so it pages rather than reading them all.
 */
export function pageOf<T>(items: readonly T[], page: number, size: number): Paged<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1), pages);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    pages,
    total: items.length,
  };
}

// ---- the draft --------------------------------------------------------------

/** A new key: active, nothing else. The form warns that no access means every API. */
export function newKeyDraft(): KeySession {
  return { active: true };
}

/** `draft` with one field set; `undefined` removes it (g2way's default). */
export function withKeyField<K extends keyof KeySession>(
  draft: KeySession,
  key: K,
  value: KeySession[K] | undefined,
): KeySession {
  const next = { ...draft };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** Fields the form does not edit that the draft carries. */
export function otherKeyFields(draft: KeySession): string[] {
  return Object.keys(draft).filter(
    (key) => key !== 'org_id' && !(KEY_FORM_FIELDS as readonly string[]).includes(key),
  );
}

/** Whether the key's own access grants every API: no `access`, or an empty map. */
export function grantsEveryApi(draft: KeySession): boolean {
  return Object.keys(draft.access ?? {}).length === 0;
}

/** Whether a parsed value can stand in for a draft: any JSON object (every field is optional). */
export function isKeyShape(value: unknown): value is KeySession {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type KeyProblems = Partial<Record<KeyFormField | 'access', string>>;

const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;

/**
 * What the form can tell before the gateway does: `KeySession::validate`'s
 * rules the form covers (no zero in a limit, no empty `access` key) and the
 * one-policy limit. The gateway's own 400 message is shown verbatim on save.
 */
export function keyProblems(draft: KeySession): KeyProblems {
  const problems: KeyProblems = {};
  const { rate, quota } = draft;
  if (rate && !(positive(rate.requests) && positive(rate.per_seconds))) {
    problems.rate = 'Requests and window must both be whole numbers of at least 1.';
  }
  if (quota && !(positive(quota.max) && positive(quota.renewal_rate_secs))) {
    problems.quota = 'Maximum and period must both be whole numbers of at least 1.';
  }
  if ((draft.apply_policies?.length ?? 0) > 1) {
    problems.apply_policies = 'g2way applies at most one policy per key.';
  }
  if (draft.expires_at != null && !(Number.isInteger(draft.expires_at) && draft.expires_at > 0)) {
    problems.expires_at = 'Not a valid time.';
  }
  if (Object.keys(draft.access ?? {}).some((apiId) => apiId.trim() === '')) {
    problems.access = 'An access entry has an empty api_id.';
  }
  return problems;
}

// ---- expiry as a datetime-local input value ---------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Unix seconds as a `datetime-local` value in the browser's zone; `''` for none. */
export function toDateTimeLocal(unixSecs: number | null | undefined): string {
  if (unixSecs == null) return '';
  const d = new Date(unixSecs * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (the browser's zone) as Unix seconds; `null` for blank or invalid. */
export function fromDateTimeLocal(text: string): number | null {
  if (text.trim() === '') return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}
