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
  VERSIONED,
  withoutRawKey,
  type AuditSink,
  type GatewayWrite,
} from './audit-trail';
import { ENVIRONMENT_HEADER } from './client';
import { ENVIRONMENT_COOKIE, pickEnvironmentId } from './selected-environment';
import { GatewayError, describeFetchError } from './errors';
import { operationPermission } from './operation-permissions';
import { isBodyOrgScoped, scopeBody, withOrgId } from './org-scope';
import { ADMIN_SECRET_HEADER, GATEWAY_TIMEOUT_MS } from './server-client';
import {
  REVEAL_PERMISSION,
  SECRET_MASK,
  containsMask,
  findMasked,
  mayReveal,
  redactEachFor,
  type SecretKind,
} from '@/lib/secrets/redact';

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
 * `org_id` (see `./org-scope`, ADR-0007): in the query, overwriting any the
 * browser sent, and in the body of API, policy and key writes, where a body
 * naming another org is refused as a cross-org write.
 *
 * Every write (non-GET) that reaches the role check is audited (ADR-0006): a
 * refused one as `denied`; an allowed one gets a `pending` row *before* the
 * gateway is called — if that row cannot be written the write is refused (503),
 * so no gateway write goes unrecorded — and the row is completed with the
 * gateway's answer, the state before (a GET of the same item) and after (a GET
 * once it succeeded).
 *
 * Secrets (ADR-0010): a GET of API definitions, policies or a key session is
 * redacted for a role without that kind's write permission, and a write whose
 * body carries the redaction mask is refused (`denied`, 422), so a masked
 * value can never replace a real secret.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * GET operations whose answer carries a kind's secrets, one record or a list
 * of them (ADR-0010). `GET /g2/keys` lists hashes only, so it is not here.
 */
export const SECRET_READS: Readonly<Record<string, SecretKind>> = {
  '/g2/apis': 'api',
  '/g2/apis/{id}': 'api',
  '/g2/policies': 'policy',
  '/g2/policies/{id}': 'policy',
  '/g2/keys/{key}': 'key',
};

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
export function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  const response = Response.json({ error: message }, { status, headers });
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** How the dashboard works out its own origin, for the CSRF check. */
export type OriginConfig = {
  /**
   * Believe `X-Forwarded-Host` / `X-Forwarded-Proto`: only when a proxy we
   * control sets them (`AUTH_TRUST_HOST=true`, the same switch Auth.js uses).
   */
  trustForwarded: boolean;
  /** The dashboard's public URL (`AUTH_URL`), whose origin is always accepted. */
  publicUrl?: string;
};

/** {@link OriginConfig} from `AUTH_TRUST_HOST` and `AUTH_URL`. */
export function originConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OriginConfig {
  const trust = env.AUTH_TRUST_HOST?.trim().toLowerCase();
  return {
    trustForwarded: trust === 'true' || trust === '1',
    publicUrl: env.AUTH_URL?.trim() || undefined,
  };
}

/** One cookie's value from a request's `Cookie` header. */
function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** The first value of a possibly comma-joined header (proxies append to X-Forwarded-*). */
function firstValue(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first ? first : undefined;
}

function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * The origins a same-origin browser request to this dashboard may carry: the
 * host the browser actually used (the `Host` header, or with `trustForwarded`
 * the proxy's `X-Forwarded-Host`/`-Proto`), and `AUTH_URL`'s. Not
 * `request.url`: under `next start -H 127.0.0.1` Next reports that as
 * `localhost`, which a browser on `127.0.0.1` never sends.
 */
export function expectedOrigins(request: Request, config: OriginConfig): string[] {
  const url = new URL(request.url);
  let host = request.headers.get('host') ?? url.host;
  let protocol = url.protocol;
  if (config.trustForwarded) {
    host = firstValue(request.headers.get('x-forwarded-host')) ?? host;
    const forwardedProto = firstValue(request.headers.get('x-forwarded-proto'));
    if (forwardedProto !== undefined) protocol = `${forwardedProto}:`;
  }
  const origins = [originOf(`${protocol}//${host}`)];
  if (config.publicUrl !== undefined) origins.push(originOf(config.publicUrl));
  return origins.filter((origin): origin is string => origin !== undefined);
}

/**
 * True when a mutating request plainly comes from another site (CSRF): the
 * browser says so in `Sec-Fetch-Site`, or its `Origin` is not one of
 * {@link expectedOrigins}. A request with neither header (a non-browser
 * client) is not a CSRF vector and passes; the session still applies.
 */
export function isCrossSite(request: Request, config: OriginConfig = originConfig()): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  const normalised = originOf(origin);
  return normalised === undefined || !expectedOrigins(request, config).includes(normalised);
}

/**
 * The environment a BFF request is for: the `X-G2-Environment` header when the
 * caller names one, else the shell's remembered choice, else the default.
 * Throws the registry's `UnknownEnvironmentError` / `RegistryConfigError`.
 */
export function requestTarget(request: Request, registry: Registry): GatewayTarget {
  const id = pickEnvironmentId(registry, {
    override: request.headers.get(ENVIRONMENT_HEADER) ?? undefined,
    remembered: cookieValue(request, ENVIRONMENT_COOKIE),
  });
  return resolveEnvironment(id, registry);
}

export type ProxyDeps = {
  fetch?: typeof fetch;
  registry?: Registry;
  /** Where writes are audited; the dashboard database by default. */
  audit?: AuditSink;
  /** How the CSRF check finds the dashboard's own origin; from the environment by default. */
  origin?: OriginConfig;
};

/**
 * Forwards `request` to `/g2/<segments>` on the selected gateway.
 *
 * `segments` are the decoded catch-all route params; `actor` is the signed-in
 * user, read fresh from the database for this request. Responds with the
 * gateway's status and body untouched, or a BFF error in the same `{"error"}`
 * envelope: 404/405 for endpoints the gateway does not document, 400 for a bad
 * path, an unknown environment or an org-scoped write whose body is not a JSON
 * object, 403 when the role lacks the operation's permission, for a cross-site
 * write, or for a body naming another org, 500 for broken environment
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
  const deny = async (message: string, status = 403) => {
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
    return errorResponse(status, message);
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

  if (write !== null && isCrossSite(request, deps.origin ?? originConfig())) {
    return deny('cross-site request refused');
  }

  let target: GatewayTarget;
  try {
    target = requestTarget(request, deps.registry ?? getRegistry());
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
  let body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  if (body !== undefined && isBodyOrgScoped(method, endpoint.path)) {
    const envHeader = { [ENVIRONMENT_HEADER]: target.id };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return errorResponse(400, 'invalid request body: not UTF-8 text', envHeader);
    }
    const scoped = scopeBody(method, endpoint.path, text, target.orgId);
    if (!scoped.ok) {
      return scoped.reason === 'malformed'
        ? errorResponse(400, scoped.message, envHeader)
        : deny(scoped.message);
    }
    if (scoped.body !== text) body = new TextEncoder().encode(scoped.body).buffer;
  }

  if (write !== null && body !== undefined) {
    const masked = maskedIn(body);
    if (masked.length > 0) {
      return deny(
        `refused: the body carries the redaction mask "${SECRET_MASK}" at ${masked.join(', ')}; ` +
          'writing it would replace the real secret with the mask. It comes from a read by a role ' +
          'that may not see secrets: re-read the resource with write access and edit the real value',
        422,
      );
    }
  }

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
  const secretKind = method === 'GET' ? SECRET_READS[endpoint.path] : undefined;
  if (secretKind !== undefined && upstream.ok && !mayReveal(role, secretKind)) {
    return redactedRead(upstream, secretKind, role, responseHeaders, target.id);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// ---- secret visibility (ADR-0010) --------------------------------------------

/**
 * A successful secret-bearing read, redacted for `role`. It fails closed: a
 * body that is not JSON cannot be redacted, so it is not passed on.
 */
async function redactedRead(
  upstream: Response,
  kind: SecretKind,
  role: AuditActor['role'],
  headers: Headers,
  environment: string,
): Promise<Response> {
  const json = parseJson(await upstream.arrayBuffer());
  if (json === null) {
    return errorResponse(
      502,
      `the gateway's answer is not JSON, so its secrets cannot be hidden from the ${role} role ` +
        `(no ${REVEAL_PERMISSION[kind]}); it was not passed on`,
      { [ENVIRONMENT_HEADER]: environment },
    );
  }
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(redactEachFor(role, kind, json)), {
    status: upstream.status,
    headers,
  });
}

/** Where a write body carries {@link SECRET_MASK} (whole or URL-encoded): parsed paths, or the body itself if not JSON. */
function maskedIn(body: ArrayBuffer): string[] {
  const json = parseJson(body);
  if (json !== null) return findMasked(json);
  return containsMask(new TextDecoder().decode(body)) ? ['(the body)'] : [];
}

// ---- audited writes (ADR-0006) ---------------------------------------------

/** Writes an audit row that must not block the response; a failure is logged loudly. */
export async function recordLoudly(audit: AuditSink, record: AuditRecord): Promise<void> {
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
    const kind = collection === null ? undefined : VERSIONED[collection];
    if (kind !== undefined && finalTarget !== null && audit.version !== undefined) {
      try {
        await audit.version({
          environment: target.id,
          kind,
          resourceId: finalTarget,
          action: method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'update',
          before,
          // If the read-back failed, what the gateway just accepted is the next best record.
          after: method === 'DELETE' ? null : (after ?? requestBody),
          actor,
          auditId,
        });
      } catch (error) {
        console.error(
          `[history] FAILED to keep the version from ${write.action} ${finalTarget} (audit ${auditId}):`,
          error,
        );
      }
    }
    if (
      collection === 'keys' &&
      method === 'DELETE' &&
      finalTarget !== null &&
      audit.forgetKey !== undefined
    ) {
      // The key is gone, so is its dashboard inventory row (ADR-0009 §7).
      try {
        await audit.forgetKey({ environment: target.id, keyHash: finalTarget, actor });
      } catch (error) {
        console.error(
          `[inventory] FAILED to drop the metadata of deleted key ${finalTarget} (audit ${auditId}):`,
          error,
        );
      }
    }
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
