/**
 * The policy list's view of `Policy`: one summary row per policy, and the
 * search carried in the page's query string. Universal and pure.
 */

import type { components } from '../../../contracts/g2way.d.ts';

export type Policy = components['schemas']['Policy'];
export type RateLimit = components['schemas']['RateLimit'];
export type Quota = components['schemas']['Quota'];

export type PolicySummary = {
  policyId: string;
  name: string;
  /** g2way's serde default is `true` (`policy.rs`); the OpenAPI omits it. */
  active: boolean;
  /** `null`: unlimited (an absent or `null` `rate`). */
  rate: RateLimit | null;
  /** `null`: unlimited. */
  quota: Quota | null;
  /** The `api_id`s granted; empty means **every API in the org** (the contract). */
  apis: string[];
};

export function summarisePolicy(policy: Policy): PolicySummary {
  return {
    policyId: policy.policy_id,
    name: policy.name,
    active: policy.active ?? true,
    rate: policy.rate ?? null,
    quota: policy.quota ?? null,
    apis: Object.keys(policy.access ?? {}),
  };
}

/** A whole number of seconds in the largest unit that divides it: `60` is `1 min`. */
export function describeSeconds(seconds: number): string {
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'h'],
    [60, 'min'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return unit === 'day' ? `${count} day${count === 1 ? '' : 's'}` : `${count} ${unit}`;
    }
  }
  return `${seconds} s`;
}

export function describeRate(rate: RateLimit | null): string {
  return rate === null ? 'unlimited' : `${rate.requests} / ${describeSeconds(rate.per_seconds)}`;
}

export function describeQuota(quota: Quota | null): string {
  return quota === null
    ? 'unlimited'
    : `${quota.max} / ${describeSeconds(quota.renewal_rate_secs)}`;
}

/**
 * The summaries whose name, id or a granted `api_id` contains `q`
 * (case-insensitive), in the gateway's order (it sorts by id).
 */
export function filterPolicies(policies: readonly PolicySummary[], q: string): PolicySummary[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [...policies];
  return policies.filter((policy) =>
    [policy.name, policy.policyId, ...policy.apis].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}
