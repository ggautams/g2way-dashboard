import 'server-only';

import spec from '../../../contracts/openapi.json';

/**
 * `ApiDefinition`'s JSON Schema, straight from g2way's OpenAPI document: the
 * definition plus every schema it references, and nothing else (about 60 KB,
 * versus the whole document). References stay `#/components/schemas/…`, which
 * resolve inside this object. OpenAPI 3.1 schemas are JSON Schema 2020-12.
 * Built on the server and handed to the designer as a prop.
 */

export type JsonSchema = { $id: string; [key: string]: unknown };

export const API_DEFINITION_SCHEMA_ID = 'g2way://schemas/api-definition.json';

export function apiDefinitionSchema(): JsonSchema {
  const all = spec.components.schemas as Record<string, unknown>;
  const needed = new Set<string>(['ApiDefinition']);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.split('/').at(-1)!;
        if (!needed.has(name)) {
          needed.add(name);
          walk(all[name]);
        }
      } else walk(value);
    }
  };
  walk(all.ApiDefinition);
  return {
    $id: API_DEFINITION_SCHEMA_ID,
    $ref: '#/components/schemas/ApiDefinition',
    components: { schemas: Object.fromEntries([...needed].sort().map((n) => [n, all[n]])) },
  };
}
