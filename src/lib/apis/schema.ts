import 'server-only';

import { contractSchema, type JsonSchema } from '@/lib/designer/schema';

/** `ApiDefinition`'s JSON Schema from the contract, for the API designer. */

export const API_DEFINITION_SCHEMA_ID = 'g2way://schemas/api-definition.json';

export function apiDefinitionSchema(): JsonSchema {
  return contractSchema('ApiDefinition', API_DEFINITION_SCHEMA_ID);
}
