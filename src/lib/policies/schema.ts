import 'server-only';

import { contractSchema, type JsonSchema } from '@/lib/designer/schema';

/** `Policy`'s JSON Schema from the contract, for the policy designer's raw view. */

export const POLICY_SCHEMA_ID = 'g2way://schemas/policy.json';

export function policySchema(): JsonSchema {
  return contractSchema('Policy', POLICY_SCHEMA_ID);
}
