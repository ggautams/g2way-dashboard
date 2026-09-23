import 'server-only';

import {
  CONSOLE_MAX_RESPONSE_BYTES,
  type ConsoleAnswer,
  type ConsoleRequest,
} from '@/lib/apis/console';
import {
  CONSOLE_TIMEOUT_MS,
  consoleTarget,
  gatewayErrorOf,
  isTextual,
  parseConsoleRequest,
} from '@/lib/apis/console-guard';
import { chainFor } from '@/lib/apis/chain';
import type { ApiDefinition } from '@/lib/apis/list';
import { inferTrace } from '@/lib/apis/trace';
import { can } from '@/lib/auth/rbac';
import type { AuditActor, AuditRecord } from '@/lib/db/audit';
import { databaseAuditSink } from './audit-trail';
import { unwrap } from './client';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getRegistry,
  type GatewayTarget,
} from './environments';
import { GatewayError, GatewayUnreachableError } from './errors';
import {
  ENVIRONMENT_HEADER,
  errorResponse,
  isCrossSite,
  originConfig,
  recordLoudly,
  requestTarget,
  type ProxyDeps,
} from './proxy';
import { gatewayClient } from './server-client';

/**
 * The request console's BFF (ADR-0011): sends one test request through an
 * environment's **proxy** listener and answers with the response and an
 * inferred middleware trace.
 *
 * - The URL is always the environment's configured proxy base plus the API's
 *   stored `listen_path` plus the browser's suffix, after `consoleTarget`'s
 *   SSRF guard. The listen path is read from the gateway (admin API), never
 *   taken from the browser. Redirects are not followed, the call times out,
 *   and only the first {@link CONSOLE_MAX_RESPONSE_BYTES} of the body are read.
 * - The admin secret is never sent there, and neither are the browser's own
 *   headers or cookies: only the headers the console lists.
 * - Needs `apis:test`. Audited as `api.test_request`, write-ahead and fail
 *   closed like a gateway write (ADR-0006), recording the method, path,
 *   version and status only: no query string, header values or body, which
 *   is where test credentials live.
 */

export const CONSOLE_ACTION = 'api.test_request';

/** What the audit row says it left out. */
const AUDIT_NOTE =
  'request console: sent to the proxy listener; query string, headers and body are not recorded (ADR-0011)';

export type ConsoleDeps = ProxyDeps & {
  /** Unix seconds, for version expiry in the trace. */
  nowSecs?: () => number;
  /** A monotonic clock in milliseconds, for timing. */
  clock?: () => number;
};

function answer(body: ConsoleAnswer, environment: string): Response {
  return Response.json(body, {
    headers: { 'cache-control': 'no-store', [ENVIRONMENT_HEADER]: environment },
  });
}

/** Reads at most `cap + 1` bytes of `response`'s body, then stops. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total > cap) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, cap + 1));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return bytes;
}

/**
 * Why the proxy listener could not be reached, without its address: the
 * browser never learns the proxy URL, and Node's messages name the host.
 */
function unreachable(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `no response within ${CONSOLE_TIMEOUT_MS / 1000} s`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : null;
  return code ?? 'the connection failed';
}

/** Puts the requested version where the definition's selector reads it. */
function withVersion(
  def: ApiDefinition,
  wanted: ConsoleRequest,
):
  | { ok: true; headers: [string, string][]; query: [string, string] | null }
  | { ok: false; error: string } {
  if (wanted.version === null) return { ok: true, headers: wanted.headers, query: null };
  const chain = chainFor(def);
  if (!chain.versioned) return { ok: false, error: `API ${def.api_id} is not versioned` };
  const { location, key } = chain.selector;
  if (location === 'query_param') {
    return { ok: true, headers: wanted.headers, query: [key, wanted.version] };
  }
  const others = wanted.headers.filter(([name]) => name.toLowerCase() !== key.toLowerCase());
  return { ok: true, headers: [...others, [key, wanted.version]], query: null };
}

/**
 * Sends the console request in `request`'s JSON body for `actor`. Answers a
 * {@link ConsoleAnswer}, or the `{"error"}` envelope: 400 for a malformed or
 * unsafe request, 403 without `apis:test` or for a cross-site call, the
 * gateway's own status and message when the definition cannot be read, 409
 * when the environment has no proxy URL, 502 when the proxy listener cannot
 * be reached, 503 when the audit row cannot be written (nothing is sent).
 */
export async function sendConsoleRequest(
  request: Request,
  actor: AuditActor,
  deps: ConsoleDeps = {},
): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, 'invalid console request: the body is not JSON');
  }
  const parsed = parseConsoleRequest(json);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const wanted = parsed.value;

  const audit = deps.audit ?? databaseAuditSink();
  const base: AuditRecord = {
    actor,
    action: CONSOLE_ACTION,
    target: wanted.apiId,
    request: { method: wanted.method, version: wanted.version },
    outcome: 'pending',
    notes: [AUDIT_NOTE],
  };
  const deny = async (message: string) => {
    await recordLoudly(audit, { ...base, outcome: 'denied', error: message });
    return errorResponse(403, message);
  };
  if (!can(actor.role, 'apis:test')) {
    return deny(
      `forbidden: the ${actor.role} role lacks the apis:test permission (request console)`,
    );
  }
  if (isCrossSite(request, deps.origin ?? originConfig()))
    return deny('cross-site request refused');

  let target: GatewayTarget;
  try {
    target = requestTarget(request, deps.registry ?? getRegistry());
  } catch (error) {
    if (error instanceof UnknownEnvironmentError) return errorResponse(400, error.message);
    if (error instanceof RegistryConfigError) return errorResponse(500, error.message);
    throw error;
  }
  const envHeader = { [ENVIRONMENT_HEADER]: target.id };
  if (target.proxyUrl === null) {
    return errorResponse(
      409,
      `the request console is not configured for environment ${target.id}: set its proxy URL ` +
        '(G2_PROXY_URL, or G2_ENV_<ID>_PROXY_URL) on the dashboard server',
      envHeader,
    );
  }

  let def: ApiDefinition;
  try {
    def = await unwrap(
      gatewayClient(target.id, { fetch: deps.fetch, registry: deps.registry }).GET(
        '/g2/apis/{id}',
        {
          params: { path: { id: wanted.apiId } },
        },
      ),
    );
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.status, error.message, envHeader);
    if (error instanceof GatewayUnreachableError)
      return errorResponse(502, error.message, envHeader);
    throw error;
  }

  const versioned = withVersion(def, wanted);
  if (!versioned.ok) return errorResponse(400, versioned.error, envHeader);
  const guarded = consoleTarget(target.proxyUrl, def.listen_path, wanted.path);
  if (!guarded.ok) return errorResponse(400, guarded.error, envHeader);
  const { url } = guarded.value;
  if (versioned.query !== null) url.searchParams.set(...versioned.query);
  const sent = {
    method: wanted.method,
    path: guarded.value.path,
    query: url.search.slice(1),
    headerNames: versioned.headers.map(([name]) => name),
  };
  const hasBody = wanted.method !== 'GET' && wanted.method !== 'HEAD';
  if (!hasBody && wanted.body !== '') {
    return errorResponse(400, `${wanted.method} requests carry no body in the console`, envHeader);
  }
  const body = hasBody ? new TextEncoder().encode(wanted.body) : undefined;

  const record: AuditRecord = {
    ...base,
    request: { method: wanted.method, path: sent.path, version: wanted.version },
    gateway: { method: wanted.method, path: sent.path },
    environment: target.id,
  };
  let auditId: string;
  try {
    auditId = await audit.record(record);
  } catch (error) {
    console.error(`[audit] FAILED to record ${CONSOLE_ACTION} by ${actor.email}; refused:`, error);
    return errorResponse(
      503,
      'audit log unavailable: the test request was not sent (see the dashboard server log)',
      envHeader,
    );
  }
  const complete = async (final: AuditRecord) => {
    try {
      await audit.complete(auditId, final);
    } catch (error) {
      console.error(
        `[audit] FAILED to complete audit row ${auditId} (${final.outcome} ${CONSOLE_ACTION}); it stays pending:`,
        error,
      );
    }
  };

  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(url, {
      method: wanted.method,
      headers: new Headers(versioned.headers),
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
    });
  } catch (error) {
    const why = unreachable(error);
    console.error(
      `[console] test request for ${wanted.apiId} (environment ${target.id}) failed:`,
      error,
    );
    const message = `the gateway's proxy listener did not answer (environment ${target.id}): ${why}`;
    await complete({ ...record, outcome: 'failure', error: message });
    return errorResponse(502, message, envHeader);
  }
  const headersMs = clock() - started;
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(upstream, CONSOLE_MAX_RESPONSE_BYTES);
  } catch (error) {
    const message = `the response body could not be read: ${unreachable(error)}`;
    await complete({
      ...record,
      gateway: { method: wanted.method, path: sent.path, status: upstream.status },
      outcome: 'failure',
      error: message,
    });
    return errorResponse(502, message, envHeader);
  }
  const totalMs = clock() - started;

  const headers = [...upstream.headers.entries()];
  const truncated = bytes.byteLength > CONSOLE_MAX_RESPONSE_BYTES;
  const shown = truncated ? bytes.subarray(0, CONSOLE_MAX_RESPONSE_BYTES) : bytes;
  const binary = !isTextual(upstream.headers.get('content-type'));
  const text = binary ? '' : new TextDecoder().decode(shown);
  const gatewayError = binary || truncated ? null : gatewayErrorOf(text);

  await complete({
    ...record,
    gateway: { method: wanted.method, path: sent.path, status: upstream.status },
    outcome: 'success',
  });

  const trace = inferTrace(
    def,
    {
      method: wanted.method,
      path: sent.path,
      query: sent.query,
      headers: versioned.headers,
      bodyBytes: body?.byteLength ?? 0,
    },
    { status: upstream.status, headers, gatewayError },
    (deps.nowSecs ?? (() => Math.floor(Date.now() / 1000)))(),
  );
  return answer(
    {
      environment: target.id,
      sent,
      response: {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
        body: text,
        bytes: bytes.byteLength,
        truncated,
        binary,
        gatewayError,
      },
      timing: { headersMs: Math.round(headersMs), totalMs: Math.round(totalMs) },
      trace,
    },
    target.id,
  );
}
