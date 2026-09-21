import 'server-only';
import { can, type Role } from '@/lib/auth/rbac';
import spec from '../../../contracts/openapi.json';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getRegistry,
  resolveEnvironment,
  type GatewayTarget,
  type Registry,
} from './environments';
import { ENVIRONMENT_HEADER } from './client';
import { describeFetchError } from './errors';
import { operationPermission } from './operation-permissions';
import { withOrgId } from './org-scope';
import { ADMIN_SECRET_HEADER, GATEWAY_TIMEOUT_MS } from './server-client';

export { ENVIRONMENT_HEADER };

/**
 * The BFF proxy: forwards a browser request to one gateway's admin API, attaching
 * the admin secret server-side. The browser never sees the secret, the gateway
 * never sees the browser's cookies, and the gateway's `{"error": "..."}` envelope
 * comes back byte-for-byte.
 *
 * Only endpoints in the gateway's own OpenAPI document are forwarded; the
 * allowlist is derived from `contracts/openapi.json`, so `npm run sync:g2way`
 * keeps it current. Each forwarded operation also needs the caller's role to
 * hold the permission `./operation-permissions` maps it to; an unmapped one is
 * refused (default deny, ADR-0005). Org-scoped operations get the configured
 * `org_id` (see `./org-scope`), overwriting any the browser sent.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Browser request headers worth passing on. Everything else — cookies included — is dropped. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type'];

/** Gateway response headers worth passing back. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'allow'];

type Endpoint = {
  /** The spec's path template, e.g. `/g2/apis/{id}`. */
  path: string;
  /** Path segments after `/g2`; `null` is a `{param}` matching any one segment. */
  segments: readonly (string | null)[];
  methods: ReadonlySet<string>;
};

type SpecPaths = Record<string, Record<string, unknown>>;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** Compiles the `/g2/...` paths of an OpenAPI `paths` object into matchers. */
export function compileEndpoints(paths: SpecPaths): Endpoint[] {
  return Object.entries(paths)
    .filter(([path]) => path.startsWith('/g2/'))
    .map(([path, operations]) => ({
      path,
      segments: path
        .slice('/g2/'.length)
        .split('/')
        .map((segment) => (/^\{[^}]+\}$/.test(segment) ? null : segment)),
      methods: new Set(
        Object.keys(operations)
          .filter((method) => HTTP_METHODS.has(method))
          .map((method) => method.toUpperCase()),
      ),
    }));
}

const specPaths: SpecPaths = spec.paths;
const ENDPOINTS = compileEndpoints(specPaths);

function findEndpoint(segments: readonly string[]): Endpoint | undefined {
  return ENDPOINTS.find(
    (endpoint) =>
      endpoint.segments.length === segments.length &&
      endpoint.segments.every((expected, i) => expected === null || expected === segments[i]),
  );
}

/** A BFF-originated error, in the gateway's own envelope. */
function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  const response = Response.json({ error: message }, { status, headers });
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** True when a mutating request plainly comes from another site (CSRF). */
function isCrossSite(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = request.headers.get('origin');
  return origin !== null && origin !== new URL(request.url).origin;
}

export type ProxyDeps = {
  fetch?: typeof fetch;
  registry?: Registry;
};

/**
 * Forwards `request` to `/g2/<segments>` on the selected gateway.
 *
 * `segments` are the decoded catch-all route params; `role` is the signed-in
 * user's, read fresh from the database for this request. Responds with the
 * gateway's status and body untouched, or a BFF error in the same `{"error"}`
 * envelope: 404/405 for endpoints the gateway does not document, 400 for a bad
 * path or unknown environment, 403 when the role lacks the operation's
 * permission or for a cross-site write, 500 for broken environment
 * configuration and 502 when the gateway cannot be reached.
 */
export async function proxyToGateway(
  request: Request,
  segments: readonly string[],
  role: Role,
  deps: ProxyDeps = {},
): Promise<Response> {
  const path = `/g2/${segments.join('/')}`;
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return errorResponse(400, `invalid gateway path: ${path}`);
  }

  const endpoint = findEndpoint(segments);
  if (endpoint === undefined) return errorResponse(404, `not a g2way admin endpoint: ${path}`);
  const method = request.method.toUpperCase();
  if (!endpoint.methods.has(method)) {
    return errorResponse(405, `${method} is not supported on ${path}`, {
      allow: [...endpoint.methods].join(', '),
    });
  }

  const permission = operationPermission(method, endpoint.path);
  if (permission === undefined) {
    return errorResponse(
      403,
      `forbidden: ${method} ${endpoint.path} has no dashboard permission mapped, so it is refused`,
    );
  }
  if (!can(role, permission)) {
    return errorResponse(
      403,
      `forbidden: the ${role} role lacks the ${permission} permission (${method} ${endpoint.path})`,
    );
  }

  if (MUTATING_METHODS.has(method) && isCrossSite(request)) {
    return errorResponse(403, 'cross-site request refused');
  }

  let target: GatewayTarget;
  try {
    const registry = deps.registry ?? getRegistry();
    target = resolveEnvironment(request.headers.get(ENVIRONMENT_HEADER) ?? undefined, registry);
  } catch (error) {
    if (error instanceof UnknownEnvironmentError) return errorResponse(400, error.message);
    if (error instanceof RegistryConfigError) return errorResponse(500, error.message);
    throw error;
  }

  const headers = new Headers({ [ADMIN_SECRET_HEADER]: target.secret });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const url = withOrgId(
    new URL(
      `${target.baseUrl}/g2/${segments.map(encodeURIComponent).join('/')}${new URL(request.url).search}`,
    ),
    method,
    endpoint.path,
    target.orgId,
  ).toString();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(url, {
      method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    return errorResponse(
      502,
      `gateway unreachable (environment ${target.id}): ${describeFetchError(error)}`,
      {
        [ENVIRONMENT_HEADER]: target.id,
      },
    );
  }

  const responseHeaders = new Headers({
    'cache-control': 'no-store',
    [ENVIRONMENT_HEADER]: target.id,
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
