/**
 * The limits in effect for one key, for the key view's Usage panel. Universal
 * and pure.
 *
 * Only the _configured_ limits: g2way keeps the live quota counter, its reset
 * time and the rate window in its own storage and exposes none of them on the
 * admin API (`/g2/stats` is per API and per process). The dashboard never
 * reads g2way's storage itself; it waits for a usage endpoint (`UPSTREAM.md`).
 *
 * A non-empty `apply_policies` replaces the key's own rate and quota at auth
 * time (`docs/g2way-map.md`, key defaults), so the policy's limits, including
 * an absent one (unlimited), are the ones in effect.
 */

import type { Outcome } from '@/lib/g2/gateway-status';
import { summarisePolicy, type Policy, type Quota, type RateLimit } from '@/lib/policies/list';
import type { KeySession } from './session';

export type EffectiveLimits =
  | { source: 'key'; rate: RateLimit | null; quota: Quota | null }
  | {
      source: 'policy';
      policyId: string;
      name: string;
      active: boolean;
      rate: RateLimit | null;
      quota: Quota | null;
    }
  | {
      /** The applied policy could not be read, so the limits in effect are unknown. */
      source: 'policy-unavailable';
      policyId: string;
      error: string;
      status?: number;
    };

/**
 * `session`'s limits in effect. `applied` is the `GET /g2/policies/{id}`
 * outcome for its applied policy; ignored when it applies none.
 */
export function effectiveLimits(
  session: KeySession,
  applied: Outcome<Policy> | null,
): EffectiveLimits {
  const policyId = session.apply_policies?.[0];
  if (policyId === undefined) {
    return { source: 'key', rate: session.rate ?? null, quota: session.quota ?? null };
  }
  if (applied === null) {
    return { source: 'policy-unavailable', policyId, error: 'not loaded' };
  }
  if (!applied.ok) {
    return {
      source: 'policy-unavailable',
      policyId,
      error: applied.error,
      ...(applied.status === undefined ? {} : { status: applied.status }),
    };
  }
  const summary = summarisePolicy(applied.value);
  return {
    source: 'policy',
    policyId,
    name: summary.name,
    active: summary.active,
    rate: summary.rate,
    quota: summary.quota,
  };
}

/** The upstream item the Usage panel points at, as titled in `UPSTREAM.md`. */
export const USAGE_UPSTREAM_ITEM = 'No per-key usage endpoint.';
