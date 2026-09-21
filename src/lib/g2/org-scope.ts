import spec from '../../../contracts/openapi.json';

/**
 * Which admin operations are scoped to an org, derived from the gateway's own
 * OpenAPI document: those declaring an `org_id` query parameter. Every such call
 * carries the configured org (`G2_ORG_ID`) — set here, never by the caller, so a
 * browser cannot pick an org and nothing hardcodes `"default"`.
 */

type Parameter = { name?: string; in?: string };
type SpecPaths = Record<string, Record<string, { parameters?: readonly Parameter[] } | unknown>>;

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
