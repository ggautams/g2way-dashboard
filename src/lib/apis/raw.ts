/**
 * The designer's raw view: a draft as JSON or YAML text, and back. Universal
 * (the client editor and the tests share it); validation against g2way's
 * schema (`apiDefinitionSchema()`) runs in the browser with Ajv, in both
 * formats, so YAML gets the same checks as Monaco's JSON mode.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ApiDefinition } from './list';

export const RAW_FORMATS = ['json', 'yaml'] as const;
export type RawFormat = (typeof RAW_FORMATS)[number];

export function serialize(draft: ApiDefinition, format: RawFormat): string {
  return format === 'json' ? `${JSON.stringify(draft, null, 2)}\n` : stringifyYaml(draft);
}

/** Text as a JSON value, or why it does not parse, in the parser's words. */
export function parseRaw(
  text: string,
  format: RawFormat,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: format === 'json' ? JSON.parse(text) : parseYaml(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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

export type SchemaProblem = { path: string; message: string };

/** A validator for `schema` (the `apiDefinitionSchema()` shape). */
export function schemaValidator(schema: object): (value: unknown) => SchemaProblem[] {
  let validate: ValidateFunction | undefined;
  return (value) => {
    // Compiled on first use: Ajv compiles to code, which is not free.
    validate ??= new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(
      schema,
    );
    return validate(value) ? [] : describe(validate.errors ?? []);
  };
}

/**
 * Ajv's errors, reduced to one line per location. A `oneOf` over the auth
 * modes fails every branch, so an error about a branch is dropped when a more
 * specific one names the same path.
 */
function describe(errors: readonly ErrorObject[]): SchemaProblem[] {
  const problems = new Map<string, string>();
  for (const error of errors) {
    const path = error.instancePath === '' ? '(top level)' : error.instancePath;
    const message =
      error.keyword === 'additionalProperties'
        ? `unknown field "${String(error.params.additionalProperty)}"`
        : error.keyword === 'required'
          ? `missing "${String(error.params.missingProperty)}"`
          : (error.message ?? error.keyword);
    if (!problems.has(path) || error.keyword !== 'oneOf') problems.set(path, message);
  }
  return [...problems].map(([path, message]) => ({ path, message }));
}
