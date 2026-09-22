/**
 * The API designer's raw view: which parsed values can stand in for a draft.
 * Serialising, parsing and schema validation are shared by every designer
 * (`@/lib/designer/raw`). Universal.
 */

import type { ApiDefinition } from './list';

/**
 * Whether a parsed value can stand in for a draft in the form: an object whose
 * four required fields are strings. A schema-invalid definition still can (the
 * problems are listed, and the gateway has the last word); a value without
 * those fields cannot, because the form reads them.
 */
export function isDraftShape(value: unknown): value is ApiDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['api_id', 'name', 'listen_path', 'target_url'].every(
    (key) => typeof record[key] === 'string',
  );
}
