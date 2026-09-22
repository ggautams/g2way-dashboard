/**
 * Every designer's raw view: a draft as JSON or YAML text, and back. Universal
 * (the client editors and the tests share it); validation against g2way's
 * schema (a `contractSchema()`) runs in the browser with Ajv, in both formats,
 * so YAML gets the same checks as Monaco's JSON mode.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const RAW_FORMATS = ['json', 'yaml'] as const;
export type RawFormat = (typeof RAW_FORMATS)[number];

export function serialize(draft: object, format: RawFormat): string {
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

export type SchemaProblem = { path: string; message: string };

/** A validator for `schema` (a `contractSchema()`). */
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
