/**
 * The policy designer's model: a draft is a whole `Policy`, edited field by
 * field, so everything the form does not show survives an edit byte for byte. Universal: the client designer and the tests
 * share it.
 */

import { parseWholeNumber } from '@/lib/apis/draft';
import { accessProblem } from '@/lib/designer/access';
import type { Policy, Quota, RateLimit } from './list';

/** The fields the structured form edits; the raw editor covers the rest. */
export const POLICY_FORM_FIELDS = [
  'policy_id',
  'name',
  'active',
  'rate',
  'quota',
  'access',
] as const satisfies readonly (keyof Policy)[];

export type PolicyFormField = (typeof POLICY_FORM_FIELDS)[number];

/** Help text keys: the form fields and the limits' own fields. */
export type PolicyHelpKey =
  PolicyFormField | 'rate.requests' | 'rate.per_seconds' | 'quota.max' | 'quota.renewal_rate_secs';

/** Where a newly enabled limit starts: the contract's own example policy. */
export const DEFAULT_RATE: RateLimit = { requests: 10, per_seconds: 60 };
export const DEFAULT_QUOTA: Quota = { max: 1000, renewal_rate_secs: 86_400 };

/**
 * A new policy: the two required fields, empty, and active as g2way defaults
 * it. No `access`, which g2way reads as an empty map: every API in the org.
 * The form says so.
 */
export function newPolicyDraft(): Policy {
  return { policy_id: '', name: '', active: true };
}

/** `draft` with one field set; `undefined` removes it (g2way's default: unlimited, active). */
export function withPolicyField<K extends keyof Policy>(
  draft: Policy,
  key: K,
  value: Policy[K] | undefined,
): Policy {
  const next = { ...draft };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** Fields the form does not edit that the draft carries. */
export function otherPolicyFields(draft: Policy): string[] {
  return Object.keys(draft).filter(
    (key) => key !== 'org_id' && !(POLICY_FORM_FIELDS as readonly string[]).includes(key),
  );
}

/** Whether the policy grants every API in the org: no `access`, or an empty map. */
export function grantsEveryApi(draft: Policy): boolean {
  return Object.keys(draft.access ?? {}).length === 0;
}

/**
 * A limit's count or period as typed: g2way refuses zero ("use None for
 * unlimited, never zero", `Policy::validate`), so it is a whole number of at
 * least 1, and blank is a problem, not a default.
 */
export function parseLimit(
  text: string,
): { ok: true; value: number } | { ok: false; problem: string } {
  const parsed = parseWholeNumber(text, 1);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return { ok: false, problem: 'Required while the limit is on.' };
  return { ok: true, value: parsed.value };
}

/**
 * Whether a parsed value can stand in for a draft in the form: an object whose
 * required `policy_id` and `name` are strings. Schema problems are listed
 * separately; the gateway has the last word.
 */
export function isPolicyShape(value: unknown): value is Policy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.policy_id === 'string' && typeof record.name === 'string';
}

export type PolicyProblems = Partial<Record<PolicyFormField, string>>;

const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;

/**
 * What the form can tell before the gateway does: `Policy::validate`'s rules
 * (non-empty id and name, no zero in a limit, no empty `access` key) and the
 * access matrix's own checks (`accessProblem`). The
 * gateway's own 400 message is shown verbatim on save.
 */
export function policyProblems(draft: Policy): PolicyProblems {
  const problems: PolicyProblems = {};
  if (draft.policy_id.trim() === '') problems.policy_id = 'Give the policy an id.';
  else if (/[\s/?#]/.test(draft.policy_id)) problems.policy_id = 'No spaces, slashes, ? or #.';
  if (draft.name.trim() === '') problems.name = 'Give the policy a name.';
  const { rate, quota } = draft;
  if (rate && !(positive(rate.requests) && positive(rate.per_seconds))) {
    problems.rate = 'Requests and window must both be whole numbers of at least 1.';
  }
  if (quota && !(positive(quota.max) && positive(quota.renewal_rate_secs))) {
    problems.quota = 'Maximum and period must both be whole numbers of at least 1.';
  }
  const access = accessProblem(draft.access);
  if (access) problems.access = access;
  return problems;
}
