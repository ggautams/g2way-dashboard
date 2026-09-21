import 'server-only';
import { can } from '@/lib/auth/rbac';
import type { AuditActor, AuditRecord } from '@/lib/db/audit';
import type { JsonValue } from '@/lib/db/schema/shared';
import spec from '../../../contracts/openapi.json';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getRegistry,
  resolveEnvironment,
  type GatewayTarget,
  type Registry,
} from './environments';
import {
  createTargetFromBody,
  createdItem,
  databaseAuditSink,
  describeGatewayWrite,
  withoutRawKey,
  type AuditSink,
  type GatewayWrite,
} from './audit-trail';
import { ENVIRONMENT_HEADER } from './client';
import { GatewayError, describeFetchError } from './errors';
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
 *
 * Every write (non-GET) that reaches the role check is audited (ADR-0006): a
 * refused one as `denied`; an allowed one gets a `pending` row *before* the
 * gateway is called — if that row cannot be written the write is refused (503),
 * so no gateway write goes unrecorded — and the row is completed with the
 * gateway's answer, the state before (a GET of the same item) and after (a GET
 * once it succeeded).
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
  /** Where writes are audited; the dashboard database by default. */
  audit?: AuditSink;
};

/**
 * Forwards `request` to `/g2/<segments>` on the selected gateway.
 *
 * `segments` are the decoded catch-all route params; `actor` is the signed-in
 * user, read fresh from the database for this request. Responds with the
 * gateway's status and body untouched, or a BFF error in the same `{"error"}`
 * envelope: 404/405 for endpoints the gateway does not document, 400 for a bad
 * path or unknown environment, 403 when the role lacks the operation's
 * permission or for a cross-site write, 500 for broken environment
 * configuration, 502 when the gateway cannot be reached, and 503 when a write
 * cannot be audited (it is then not sent).
 */
export async function proxyToGateway(
  request: Request,
  segments: readonly string[],
  actor: AuditActor,
  deps: ProxyDeps = {},
): Promise<Response> {
  const { role } = actor;
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

  const write = MUTATING_METHODS.has(method)
    ? describeGatewayWrite(method, endpoint.path, segments, new URL(request.url).searchParams)
    : null;
  const audit = deps.audit ?? databaseAuditSink();
  /** A refused write: recorded as `denied` (best effort — nothing reached the gateway), then 403. */
  const deny = async (message: string) => {
    if (write !== null) {
      await recordLoudly(audit, {
        actor,
        action: write.action,
        target: write.target,
        outcome: 'denied',
        error: message,
        notes: write.notes,
      });
    }
    return errorResponse(403, message);
  };

  const permission = operationPermission(method, endpoint.path);
  if (permission === undefined) {
    return deny(
      `forbidden: ${method} ${endpoint.path} has no dashboard permission mapped, so it is refused`,
    );
  }
  if (!can(role, permission)) {
    return deny(
      `forbidden: the ${role} role lacks the ${permission} permission (${method} ${endpoint.path})`,
    );
  }

  if (write !== null && isCrossSite(request)) {
    return deny('cross-site request refused');
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

  const gatewayFetch = deps.fetch ?? fetch;
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

  if (write !== null) {
    return auditedWrite({
      write,
      actor,
      audit,
      endpoint,
      target,
      gatewayFetch,
      method,
      url,
      headers,
      body: body ?? new ArrayBuffer(0),
      search: new URL(request.url).searchParams,
      itemId: write.isItem ? segments[1] : null,
    });
  }

  let upstream: Response;
  try {
    upstream = await gatewayFetch(url, {
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

// ---- audited writes (ADR-0006) ---------------------------------------------

/** Writes an audit row that must not block the response; a failure is logged loudly. */
async function recordLoudly(audit: AuditSink, record: AuditRecord): Promise<void> {
  try {
    await audit.record(record);
  } catch (error) {
    console.error(
      `[audit] FAILED to record ${record.outcome} ${record.action} by ${record.actor?.email ?? 'nobody'}:`,
      error,
    );
  }
}

function parseJson(bytes: ArrayBuffer): JsonValue | null {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
  } catch {
    return null;
  }
}

/** What a request body was, for the audit row: its JSON, or a description if it isn't JSON. */
function describeBody(bytes: ArrayBuffer): JsonValue | null {
  if (bytes.byteLength === 0) return null;
  return parseJson(bytes) ?? `[non-JSON body, ${bytes.byteLength} bytes]`;
}

type ItemState = { state: JsonValue | null; note?: string };

/**
 * Reads one item back from the gateway for a before/after snapshot. A 404 is
 * "no such item" (a creation, or already gone); any other failure is `null`
 * with a note saying why, never a thrown error: a snapshot must not break the
 * write it describes.
 */
async function readItem(
  gatewayFetch: typeof fetch,
  target: GatewayTarget,
  collection: string,
  id: string,
  search: URLSearchParams,
  label: 'before' | 'after',
): Promise<ItemState> {
  const template = `/g2/${collection}/{${collection === 'keys' ? 'key' : 'id'}}`;
  const query = new URLSearchParams();
  const hashed = search.get('hashed');
  if (hashed !== null) query.set('hashed', hashed);
  const url = withOrgId(
    new URL(
      `${target.baseUrl}/g2/${collection}/${encodeURIComponent(id)}${query.size > 0 ? `?${query}` : ''}`,
    ),
    'GET',
    template,
    target.orgId,
  ).toString();
  try {
    const response = await gatewayFetch(url, {
      method: 'GET',
      headers: { [ADMIN_SECRET_HEADER]: target.secret, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const bytes = await response.arrayBuffer();
    if (response.ok) return { state: parseJson(bytes) };
    if (response.status === 404) return { state: null };
    const { message } = GatewayError.fromBody(response.status, parseJson(bytes));
    return {
      state: null,
      note: `${label}-state unavailable: GET answered ${response.status} ${message}`,
    };
  } catch (error) {
    return { state: null, note: `${label}-state unavailable: ${describeFetchError(error)}` };
  }
}

type AuditedWrite = {
  write: GatewayWrite;
  actor: AuditActor;
  audit: AuditSink;
  endpoint: Endpoint;
  target: GatewayTarget;
  gatewayFetch: typeof fetch;
  method: string;
  url: string;
  headers: Headers;
  body: ArrayBuffer;
  search: URLSearchParams;
  /** The raw item segment (`/g2/<collection>/<itemId>`), for reading it back. */
  itemId: string | null;
};

/**
 * One gateway write, audited: before-state, a `pending` row (fail closed),
 * the call, after-state, and the completed row. The gateway's response still
 * passes through untouched.
 */
async function auditedWrite(options: AuditedWrite): Promise<Response> {
  const { write, actor, audit, endpoint, target, gatewayFetch, method, url, headers, body } =
    options;
  const { collection, isItem } = write;
  const notes = [...write.notes];
  const requestBody = describeBody(body);

  let before: JsonValue | null = null;
  if (isItem && collection !== null && options.itemId !== null && endpoint.methods.has('GET')) {
    const read = await readItem(
      gatewayFetch,
      target,
      collection,
      options.itemId,
      options.search,
      'before',
    );
    before = read.state;
    if (read.note) notes.push(read.note);
  }

  const record: AuditRecord = {
    actor,
    action: write.action,
    target: write.target ?? createTargetFromBody(collection, requestBody),
    before,
    request: requestBody,
    gateway: { method, path: write.recordedPath },
    environment: target.id,
    outcome: 'pending',
    notes,
  };

  let auditId: string;
  try {
    auditId = await audit.record(record);
  } catch (error) {
    console.error(
      `[audit] FAILED to record ${write.action} by ${actor.email}; write refused:`,
      error,
    );
    return errorResponse(
      503,
      'audit log unavailable: the write was not sent to the gateway (see the dashboard server log)',
      { [ENVIRONMENT_HEADER]: target.id },
    );
  }

  const complete = async (final: AuditRecord) => {
    try {
      await audit.complete(auditId, final);
    } catch (error) {
      console.error(
        `[audit] FAILED to complete audit row ${auditId} (${final.outcome} ${final.action}); it stays pending:`,
        error,
      );
    }
  };

  let upstream: Response;
  try {
    upstream = await gatewayFetch(url, {
      method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    const message = `gateway unreachable (environment ${target.id}): ${describeFetchError(error)}`;
    await complete({ ...record, outcome: 'failure', error: message });
    return errorResponse(502, message, { [ENVIRONMENT_HEADER]: target.id });
  }

  const bytes = await upstream.arrayBuffer();
  const responseJson = parseJson(bytes);
  const gateway = { method, path: write.recordedPath, status: upstream.status };

  if (!upstream.ok) {
    const { message } = GatewayError.fromBody(upstream.status, responseJson);
    await complete({ ...record, gateway, outcome: 'failure', error: message });
  } else {
    let after: JsonValue | null = null;
    let finalTarget = record.target ?? null;
    if (method === 'DELETE') {
      after = null;
    } else if (collection !== null && options.itemId !== null) {
      const read = await readItem(
        gatewayFetch,
        target,
        collection,
        options.itemId,
        options.search,
        'after',
      );
      after = read.state;
      if (read.note) notes.push(read.note);
    } else if (collection !== null) {
      const created = createdItem(collection, responseJson);
      if (created !== null) {
        finalTarget = created.id;
        const read = await readItem(
          gatewayFetch,
          target,
          collection,
          created.id,
          new URLSearchParams(created.hashed ? { hashed: 'true' } : {}),
          'after',
        );
        after = read.state ?? withoutRawKey(collection, responseJson);
        if (read.note) notes.push(read.note);
      } else {
        after = withoutRawKey(collection, responseJson);
      }
    } else {
      after = responseJson;
    }
    await complete({
      ...record,
      target: finalTarget,
      after,
      gateway,
      outcome: 'success',
      notes,
    });
  }

  const responseHeaders = new Headers({
    'cache-control': 'no-store',
    [ENVIRONMENT_HEADER]: target.id,
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(bytes, { status: upstream.status, headers: responseHeaders });
}
