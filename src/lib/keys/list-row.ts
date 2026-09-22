/**
 * One `/keys` row as the browser gets it: display strings and the state, never
 * the session itself (a session can hold an hmac secret or basic-auth
 * credentials, and the list has no business shipping those to the page).
 * Universal and pure.
 */

import { describeQuota, describeRate } from '@/lib/policies/list';
import { keyState, type KeyLabels, type KeyState } from './filter';
import { shortHash, summariseKey, type KeySession } from './session';

export type KeyListRow = {
  hash: string;
  short: string;
  /** The dashboard label, else the gateway alias, else `null`. */
  title: string | null;
  /** The alias, when a label is shown instead of it. */
  alias: string | null;
  owner: string | null;
  /** Why the session could not be read; the other session fields are then empty. */
  error: string | null;
  policy: string | null;
  rate: string;
  quota: string;
  /** Unix seconds; `null`: never. */
  expiresAt: number | null;
  state: KeyState | null;
  /** No access entries and no policy: the key may call every API. */
  everyApi: boolean;
};

type SessionOutcome =
  { ok: true; value: KeySession } | { ok: false; error: string; status?: number };

export function toKeyListRow(
  hash: string,
  session: SessionOutcome,
  labels: KeyLabels | undefined,
  nowSecs: number,
): KeyListRow {
  const label = labels?.label ?? null;
  const owner = labels?.owner ?? null;
  const base = { hash, short: shortHash(hash), owner };
  if (!session.ok) {
    return {
      ...base,
      title: label,
      alias: null,
      error: `${session.error}${session.status === undefined ? '' : ` (HTTP ${session.status})`}`,
      policy: null,
      rate: '',
      quota: '',
      expiresAt: null,
      state: null,
      everyApi: false,
    };
  }
  const key = summariseKey(hash, session.value);
  return {
    ...base,
    title: label ?? key.alias,
    alias: label !== null ? key.alias : null,
    error: null,
    policy: key.policy,
    rate: key.policy ? 'from policy' : describeRate(key.rate),
    quota: key.policy ? 'from policy' : describeQuota(key.quota),
    expiresAt: key.expiresAt,
    state: keyState(key, nowSecs),
    everyApi: !key.policy && key.apis.length === 0,
  };
}
