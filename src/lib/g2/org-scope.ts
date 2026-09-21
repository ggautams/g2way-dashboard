import spec from '../../../contracts/openapi.json';

/**
 * Org scoping of gateway calls (ADR-0007), derived from the gateway's own
 * OpenAPI document, so `npm run sync:g2way` keeps it current.
 *
 * - **Query**: operations declaring an `org_id` query parameter (reads and
 *   deletes, and `PUT /g2/keys/{key}`) always carry the configured org
 *   (`G2_ORG_ID`), overwriting any the caller sent.
 * - **Body**: operations whose JSON request body is a schema with an `org_id`
 *   property (API definition, policy and key writes) are filed upstream under
 *   the *body's* org, and a body without one lands in g2way's own default org.
 *   {@link scopeBody} therefore adds the configured org when the body has none
 *   and refuses a body naming any other org — that would be a cross-tenant
 *   write — rather than silently rewriting it.
 *
 * Either way the org comes from config, never from the browser, and nothing
 * hardcodes `"default"`.
 */

type Parameter = { name?: string; in?: string };
type SpecPaths = Record<string, Record<string, { parameters?: readonly Parameter[] } | unknown>>;
type SchemaRef = { $ref?: string };
type Spec = {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

function hasOrgProperty(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || !('properties' in schema)) return false;
  const { properties } = schema;
  return typeof properties === 'object' && properties !== null && 'org_id' in properties;
}

function key(method: string, specPath: string): string {
  return `${method.toUpperCase()} ${specPath}`;
}

/** `"GET /g2/apis"`-style keys of every operation taking `?org_id=`. */
export function compileOrgScoped(paths: SpecPaths): ReadonlySet<string> {
  const scoped = new Set<string>();
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const parameters =
        typeof operation === 'object' && operation !== null && 'parameters' in operation
          ? (operation.parameters as readonly Parameter[])
          : [];
      if (parameters.some((p) => p.name === 'org_id' && p.in === 'query')) {
        scoped.add(key(method, path));
      }
    }
  }
  return scoped;
}

const ORG_SCOPED = compileOrgScoped(spec.paths as SpecPaths);

/** True when `method` on the spec path template `specPath` (e.g. `/g2/apis/{id}`) takes `org_id`. */
export function isOrgScoped(method: string, specPath: string): boolean {
  return ORG_SCOPED.has(key(method, specPath));
}

/** Sets (overwriting) `org_id` on `url` when the operation takes it; returns `url` unchanged otherwise. */
export function withOrgId(url: URL, method: string, specPath: string, orgId: string): URL {
  if (!isOrgScoped(method, specPath)) return url;
  const scoped = new URL(url);
  scoped.searchParams.set('org_id', orgId);
  return scoped;
}

/** `"POST /g2/apis"`-style keys of every operation whose JSON body schema has an `org_id` property. */
export function compileBodyOrgScoped(document: Spec): ReadonlySet<string> {
  const schemas = document.components?.schemas ?? {};
  const scoped = new Set<string>();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const body = (
        operation as { requestBody?: { content?: Record<string, { schema?: SchemaRef }> } }
      ).requestBody;
      const ref = body?.content?.['application/json']?.schema?.$ref;
      const name = ref?.startsWith('#/components/schemas/')
        ? ref.slice('#/components/schemas/'.length)
        : undefined;
      if (name !== undefined && hasOrgProperty(schemas[name])) {
        scoped.add(key(method, path));
      }
    }
  }
  return scoped;
}

const BODY_ORG_SCOPED = compileBodyOrgScoped(spec as Spec);

/** True when `method` on `specPath` sends a JSON body the gateway files under its `org_id`. */
export function isBodyOrgScoped(method: string, specPath: string): boolean {
  return BODY_ORG_SCOPED.has(key(method, specPath));
}

/**
 * A scoped body, or why it was refused: `malformed` (not a JSON object, so its
 * org cannot be checked) or `cross-org` (it names another org, or names one
 * twice).
 */
export type ScopedBody =
  { ok: true; body: string } | { ok: false; reason: 'malformed' | 'cross-org'; message: string };

/**
 * The keys of a JSON object's own top level, in source order and *with*
 * duplicates (which `JSON.parse` silently collapses to the last one). `text`
 * must already be known to parse as a JSON object.
 */
export function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1) {
        let next = end + 1;
        while (/\s/.test(text[next] ?? '')) next += 1;
        if (text[next] === ':') keys.push(JSON.parse(text.slice(i, end + 1)) as string);
      }
      i = end + 1;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    i += 1;
  }
  return keys;
}

/**
 * Scopes a write's JSON body to `orgId` for an operation the gateway files by
 * body org (see the module comment). Returns the body to send:
 *
 * - unchanged, byte for byte, when it already names `orgId` (no re-serialising,
 *   so large integers and key order survive);
 * - with `"org_id"` spliced in as the first member when it names none;
 * - refused when it names another org, names one more than once, or is not a
 *   JSON object (its org could not be checked, so it is not sent).
 *
 * Operations that are not body-scoped pass through untouched.
 */
export function scopeBody(
  method: string,
  specPath: string,
  body: string,
  orgId: string,
): ScopedBody {
  if (!isBodyOrgScoped(method, specPath)) return { ok: true, body };
  const operation = `${method.toUpperCase()} ${specPath}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'malformed',
      message: `invalid request body: ${operation} needs a JSON object, so its org_id can be checked`,
    };
  }
  const orgKeys = topLevelKeys(body).filter((name) => name === 'org_id').length;
  if (orgKeys > 1) {
    return {
      ok: false,
      reason: 'cross-org',
      message: 'forbidden: cross-org write refused: the body names org_id more than once',
    };
  }
  if (orgKeys === 1) {
    const requested = (parsed as { org_id?: unknown }).org_id;
    if (requested === orgId) return { ok: true, body };
    return {
      ok: false,
      reason: 'cross-org',
      message: `forbidden: cross-org write refused: the body's org_id ${JSON.stringify(requested)} is not this dashboard's org ${JSON.stringify(orgId)}`,
    };
  }
  const open = body.indexOf('{') + 1;
  const member = `"org_id":${JSON.stringify(orgId)}`;
  const separator = Object.keys(parsed).length === 0 ? '' : ',';
  return { ok: true, body: `${body.slice(0, open)}${member}${separator}${body.slice(open)}` };
}

/** A server-side gateway write whose body {@link scopeBody} refused; it was not sent. */
export class OrgScopeError extends Error {
  constructor(
    readonly reason: 'malformed' | 'cross-org',
    message: string,
  ) {
    super(message);
    this.name = 'OrgScopeError';
  }
}
