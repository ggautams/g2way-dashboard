import 'server-only';

import { propertyHelp } from '@/lib/designer/help';
import { KEY_FORM_FIELDS, type KeyHelpKey } from './session';

/**
 * Where the contract has no description (`KeySession.rate`/`quota` carry none),
 * the dashboard's own words, from `session.rs`'s serde defaults.
 */
const FALLBACK: Partial<Record<KeyHelpKey, string>> = {
  rate: 'Off: no rate limit on this key.',
  quota: 'Off: no quota on this key.',
};

/** The key designer's help text (g2way's rustdoc, first paragraph). */
export function keyFieldHelp(): Record<KeyHelpKey, string> {
  return {
    ...(Object.fromEntries(
      KEY_FORM_FIELDS.map((field) => [
        field,
        propertyHelp('KeySession', field) || (FALLBACK[field] ?? ''),
      ]),
    ) as Record<(typeof KEY_FORM_FIELDS)[number], string>),
    access: propertyHelp('KeySession', 'access'),
    'rate.requests': propertyHelp('RateLimit', 'requests'),
    'rate.per_seconds': propertyHelp('RateLimit', 'per_seconds'),
    'quota.max': propertyHelp('Quota', 'max'),
    'quota.renewal_rate_secs': propertyHelp('Quota', 'renewal_rate_secs'),
  };
}
