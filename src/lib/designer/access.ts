/**
 * The per-API access matrix's model, shared by the policy and key designers:
 * both carry `access: Record<api_id, ApiAccess>` with the same rules
 * (`contracts/g2way.d.ts`). Every helper edits one entry or one field and keeps
 * the rest of the value as it was, so fields the matrix does not show survive
 * the round trip through the form. Universal and pure.
 *
 * The rules, from the contract:
 * - an **empty (or absent) `access` grants every API in the org**;
 * - an entry's presence is the grant, and `{}` is unrestricted access;
 * - the GraphQL fields apply on GraphQL-configured APIs and are ignored
 *   everywhere else;
 * - a non-empty `allowed_types` wins, and `restricted_types` is then ignored;
 * - `max_query_depth`: `null`/absent inherits the API's limit, `n > 0`
 *   replaces it, and any non-positive value (`-1`) lifts it.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import type { ApiDefinition } from '@/lib/apis/list';

export type ApiAccess = components['schemas']['ApiAccess'];
export type TypeFields = components['schemas']['TypeFields'];
export type AccessMap = Record<string, ApiAccess>;

/** The two GraphQL field lists of an entry. */
export type TypeListKey = 'allowed_types' | 'restricted_types';

/** What the matrix needs to know about an API: never the whole definition. */
export type ApiChoice = { id: string; name: string; graphql: boolean };

export type ApiChoices = { ok: true; value: ApiChoice[] } | { ok: false; error: string };

/** Help text keys of the access matrix. */
export type AccessHelpKey =
  | 'access'
  | 'entry'
  | 'allowed_types'
  | 'restricted_types'
  | 'disable_introspection'
  | 'max_query_depth'
  | 'type_fields'
  | 'type_fields.name'
  | 'type_fields.fields';

export type AccessHelp = Record<AccessHelpKey, string>;

/**
 * An API as the matrix offers it. Only the id, name and whether it is
 * GraphQL-configured cross to the browser, never the definition (which can
 * carry upstream credentials).
 */
export function apiChoice(api: ApiDefinition): ApiChoice {
  return { id: api.api_id, name: api.name, graphql: api.graphql != null };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * An entry as the form reads it. The raw editor can put anything in the map,
 * so a value that is not an object reads as `{}` (the schema check lists it).
 */
export function entryOf(access: AccessMap | undefined, apiId: string): ApiAccess {
  const entry: unknown = access?.[apiId];
  return isRecord(entry) ? (entry as ApiAccess) : {};
}

/** The `api_id`s the map grants, in the map's order. */
export function grantedApis(access: AccessMap | undefined): string[] {
  return Object.keys(access ?? {});
}

/**
 * `access` with `apiId` granted, unrestricted (`{}`). An id already present
 * keeps its entry; a blank id changes nothing.
 */
export function addApi(access: AccessMap | undefined, apiId: string): AccessMap {
  const id = apiId.trim();
  const current = access ?? {};
  if (id === '' || Object.hasOwn(current, id)) return current;
  return { ...current, [id]: {} };
}

/**
 * `access` without `apiId`. Removing the last entry returns `undefined`: the
 * field is dropped, which g2way reads as `{}`, the grant of every API. The
 * matrix says so rather than hiding it.
 */
export function removeApi(access: AccessMap | undefined, apiId: string): AccessMap | undefined {
  const next = { ...(access ?? {}) };
  delete next[apiId];
  return Object.keys(next).length === 0 ? undefined : next;
}

/** `access` with `apiId`'s entry replaced; the other entries are untouched. */
export function withApiEntry(
  access: AccessMap | undefined,
  apiId: string,
  entry: ApiAccess,
): AccessMap {
  return { ...(access ?? {}), [apiId]: entry };
}

/** `entry` with one field set; `undefined` removes it (g2way's default). Unknown fields stay. */
export function withAccessField<K extends keyof ApiAccess>(
  entry: ApiAccess,
  key: K,
  value: ApiAccess[K] | undefined,
): ApiAccess {
  const next = { ...entry };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Granted ids the environment does not list. `GET /g2/apis` lists stored
 * definitions only, so an id here is either deleted or loaded from a file
 * (`--apps-dir`); the matrix says both and lets the entry be removed.
 */
export function danglingApis(access: AccessMap | undefined, apis: readonly ApiChoice[]): string[] {
  const known = new Set(apis.map((api) => api.id));
  return grantedApis(access).filter((id) => !known.has(id));
}

/** The environment's APIs not yet in `access`, for the "add" picker. */
export function ungrantedApis(
  access: AccessMap | undefined,
  apis: readonly ApiChoice[],
): ApiChoice[] {
  const granted = new Set(grantedApis(access));
  return apis.filter((api) => !granted.has(api.id));
}

// ---- GraphQL type/field lists -----------------------------------------------

/** An entry's type list as the form reads it: anything but an array reads as empty. */
export function typeListOf(entry: ApiAccess, key: TypeListKey): TypeFields[] {
  const list: unknown = entry[key];
  return Array.isArray(list) ? (list as TypeFields[]) : [];
}

/**
 * `entry` with a type list replaced. An empty list drops the field: g2way's
 * default, and the same meaning (no restriction).
 */
export function withTypeList(entry: ApiAccess, key: TypeListKey, list: TypeFields[]): ApiAccess {
  return withAccessField(entry, key, list.length === 0 ? undefined : list);
}

/** A new, blank row: the user names the type, then its fields. */
export function addTypeFields(list: readonly TypeFields[]): TypeFields[] {
  return [...list, { name: '', fields: [] }];
}

export function removeTypeFields(list: readonly TypeFields[], index: number): TypeFields[] {
  return list.filter((_, i) => i !== index);
}

/** `list` with row `index` changed; the row's other keys survive. */
export function withTypeFields(
  list: readonly TypeFields[],
  index: number,
  change: Partial<TypeFields>,
): TypeFields[] {
  return list.map((row, i) => (i === index ? { ...row, ...change } : row));
}

/** Field names as typed: comma or whitespace separated, blanks and repeats dropped. */
export function parseFieldList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((field) => field !== ''))];
}

export function formatFieldList(fields: readonly string[] | undefined): string {
  return (fields ?? []).join(', ');
}

// ---- max_query_depth --------------------------------------------------------

/**
 * The depth override as typed: blank inherits the API's limit (`undefined`,
 * so the field is dropped); any whole number is accepted, since g2way reads a
 * non-positive one as "no limit".
 */
export function parseQueryDepth(
  text: string,
): { ok: true; value: number | undefined } | { ok: false; problem: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, problem: 'Enter a whole number, -1 for no limit, or leave it blank.' };
  }
  return { ok: true, value };
}

/** What a depth override means, in words. */
export function describeQueryDepth(depth: number | null | undefined): string {
  if (depth == null) return "Inherits the API's graphql.max_query_depth.";
  if (depth <= 0) return 'No depth limit for this grant, whatever the API sets.';
  return `At most ${depth} level${depth === 1 ? '' : 's'} deep, replacing the API's limit.`;
}

// ---- summary and problems ---------------------------------------------------

/** Whether an entry restricts anything beyond the base grant. */
export function isRestricted(entry: ApiAccess): boolean {
  return (
    typeListOf(entry, 'allowed_types').length > 0 ||
    typeListOf(entry, 'restricted_types').length > 0 ||
    entry.disable_introspection === true ||
    entry.max_query_depth != null
  );
}

/**
 * What the form can tell about the map before the gateway does: an empty
 * `api_id` (refused by `validate`), and a GraphQL type row with no name, which
 * could never match. The gateway's own message is still shown on save.
 */
export function accessProblem(access: AccessMap | undefined): string | undefined {
  const ids = grantedApis(access);
  if (ids.some((id) => id.trim() === '')) return 'An access entry has an empty api_id.';
  for (const id of ids) {
    const entry = entryOf(access, id);
    for (const key of ['allowed_types', 'restricted_types'] as const) {
      if (typeListOf(entry, key).some((row) => typeof row.name !== 'string' || !row.name.trim())) {
        return `${id}: every GraphQL type in ${key} needs a name.`;
      }
    }
    const depth: unknown = entry.max_query_depth;
    if (depth != null && !Number.isSafeInteger(depth)) {
      return `${id}: max_query_depth must be a whole number.`;
    }
  }
  return undefined;
}
