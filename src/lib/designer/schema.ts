import 'server-only';

import spec from '../../../contracts/openapi.json';

/**
 * One component's JSON Schema, straight from g2way's OpenAPI document: the
 * component plus every schema it references, and nothing else (for
 * `ApiDefinition`, about 60 KB versus the whole document). References stay
 * `#/components/schemas/…`, which resolve inside this object. OpenAPI 3.1
 * schemas are JSON Schema 2020-12. Built on the server and handed to a
 * designer as a prop.
 */

export type JsonSchema = { $id: string; [key: string]: unknown };

export function contractSchema(name: string, id: string): JsonSchema {
  const all = spec.components.schemas as Record<string, unknown>;
  if (!Object.hasOwn(all, name)) throw new Error(`contracts/openapi.json has no schema ${name}`);
  const needed = new Set<string>([name]);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const ref = value.split('/').at(-1)!;
        if (!needed.has(ref)) {
          needed.add(ref);
          walk(all[ref]);
        }
      } else walk(value);
    }
  };
  walk(all[name]);
  return {
    $id: id,
    $ref: `#/components/schemas/${name}`,
    components: { schemas: Object.fromEntries([...needed].sort().map((n) => [n, all[n]])) },
  };
}
