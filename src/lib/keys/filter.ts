/**
 * The `/keys` search and filter: the state carried in the page's query string
 * (as `/apis` does it, `lib/apis/list.ts`) and the matching. Universal and pure,
 * so the page, the loader and their tests share it.
 *
 * The data sits in two places, and that shapes the cost:
 *
 * - **label and owner** are the dashboard's own (`key_metadata`, ADR-0009 §7):
 *   matching them is one database query, however many keys there are;
 * - **alias, policy and state** live only in the gateway's session, one
 *   `GET /g2/keys/{hash}?hashed=true` per key.
 *
 * So a search reads sessions in {@link scanOrder}: keys whose label or owner
 * already match first, then the rest, up to a cap the loader applies
 * (`KEY_SCAN_LIMIT`). Past the cap the answer is incomplete, and the page says so.
 */

import type { KeySummary } from './session';
import { isExpired } from './session';

export const KEY_STATES = ['all', 'active', 'revoked', 'expired'] as const;
export type KeyStateFilter = (typeof KEY_STATES)[number];
export type KeyState = Exclude<KeyStateFilter, 'all'>;

/** The `policy` filter value for "applies no policy". Not a valid-looking policy id. */
export const NO_POLICY = '-';

export type KeyFilter = {
  /** Case-insensitive substring of the label, owner or alias, or a hash prefix. */
  q: string;
  /** A policy id, {@link NO_POLICY}, or `''` for any. */
  policy: string;
  state: KeyStateFilter;
};

export const NO_KEY_FILTER: KeyFilter = { q: '', policy: '', state: 'all' };

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, name: string): string {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** The filter in `?q=&policy=&state=`; anything unrecognised means "all". */
export function parseKeyFilter(params: SearchParams): KeyFilter {
  const state = one(params, 'state');
  return {
    q: one(params, 'q'),
    policy: one(params, 'policy'),
    state: (KEY_STATES as readonly string[]).includes(state) ? (state as KeyStateFilter) : 'all',
  };
}

/** Whether anything narrows the list (else it is the plain paged list). */
export function isFiltering(filter: KeyFilter): boolean {
  return filter.q !== '' || filter.policy !== '' || filter.state !== 'all';
}

/** The query string for `filter` on page `page`, for links that keep the filter. */
export function keyFilterQuery(filter: KeyFilter, page = 1): string {
  const query = new URLSearchParams();
  if (filter.q !== '') query.set('q', filter.q);
  if (filter.policy !== '') query.set('policy', filter.policy);
  if (filter.state !== 'all') query.set('state', filter.state);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** A key's state as the list shows it: revoked wins over expired. */
export function keyState(key: Pick<KeySummary, 'active' | 'expiresAt'>, nowSecs: number): KeyState {
  if (!key.active) return 'revoked';
  return isExpired(key.expiresAt, nowSecs) ? 'expired' : 'active';
}

export type KeyLabels = { label: string | null; owner: string | null };

/** Whether the dashboard's label or owner for a key contains `q` (case-insensitive). */
export function labelsMatch(labels: KeyLabels | undefined, q: string): boolean {
  const needle = q.toLowerCase();
  if (needle === '' || labels === undefined) return false;
  return [labels.label, labels.owner].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
}

/** Whether `q` could be (the start of) a key hash: hashes are lowercase hex. */
function hashMatches(hash: string, q: string): boolean {
  const needle = q.toLowerCase();
  return /^[0-9a-f]{4,}$/.test(needle) && hash.toLowerCase().startsWith(needle);
}

/**
 * Whether one key matches `filter`: `match`, `no`, or `unknown` when the
 * session could not be read (`summary` null) and the answer depends on it.
 * A failed read never counts as a miss: the page lists such keys as unchecked.
 */
export function matchKey(
  key: { hash: string; labels?: KeyLabels; summary: KeySummary | null },
  filter: KeyFilter,
  nowSecs: number,
): 'match' | 'no' | 'unknown' {
  const { hash, labels, summary } = key;
  const byMetadata =
    filter.q === '' || labelsMatch(labels, filter.q) || hashMatches(hash, filter.q);
  if (summary === null) {
    const needsSession = filter.policy !== '' || filter.state !== 'all' || !byMetadata;
    return needsSession ? 'unknown' : 'match';
  }
  const q = filter.q.toLowerCase();
  const text =
    byMetadata || (summary.alias !== null && q !== '' && summary.alias.toLowerCase().includes(q));
  const policy =
    filter.policy === '' ||
    (filter.policy === NO_POLICY ? summary.policy === null : summary.policy === filter.policy);
  const state = filter.state === 'all' || keyState(summary, nowSecs) === filter.state;
  return text && policy && state ? 'match' : 'no';
}

/**
 * The order to read sessions in for a search: hashes whose label or owner
 * match `q` first (they may already be answers), then every other hash, each
 * group in the gateway's order. With no `q`, the gateway's order.
 */
export function scanOrder(
  hashes: readonly string[],
  labels: ReadonlyMap<string, KeyLabels>,
  q: string,
): string[] {
  if (q === '') return [...hashes];
  const first: string[] = [];
  const rest: string[] = [];
  for (const hash of hashes) {
    (labelsMatch(labels.get(hash), q) || hashMatches(hash, q) ? first : rest).push(hash);
  }
  return [...first, ...rest];
}
