import 'server-only';

import { propertyHelp } from '@/lib/designer/help';
import { POLICY_FORM_FIELDS, type PolicyHelpKey } from './draft';

/** The policy designer's help text (g2way's rustdoc, first paragraph). */
export function policyFieldHelp(): Record<PolicyHelpKey, string> {
  return {
    ...(Object.fromEntries(
      POLICY_FORM_FIELDS.map((field) => [field, propertyHelp('Policy', field)]),
    ) as Record<(typeof POLICY_FORM_FIELDS)[number], string>),
    access: propertyHelp('Policy', 'access'),
    'rate.requests': propertyHelp('RateLimit', 'requests'),
    'rate.per_seconds': propertyHelp('RateLimit', 'per_seconds'),
    'quota.max': propertyHelp('Quota', 'max'),
    'quota.renewal_rate_secs': propertyHelp('Quota', 'renewal_rate_secs'),
  };
}
