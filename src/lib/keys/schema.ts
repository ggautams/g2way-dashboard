import 'server-only';

import { contractSchema, type JsonSchema } from '@/lib/designer/schema';

/** `KeySession`'s JSON Schema from the contract, for the key designer's raw view. */

export const KEY_SCHEMA_ID = 'g2way://schemas/key-session.json';

export function keySchema(): JsonSchema {
  return contractSchema('KeySession', KEY_SCHEMA_ID);
}
