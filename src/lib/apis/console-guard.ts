/**
 * The request console's server-side checks (ADR-0011 §2): parsing what the
 * browser sent, and the SSRF guard that decides where a test request may go.
 *
 * Pure, so it is tested directly, but only the BFF (`src/lib/g2/console.ts`)
 * imports it: nothing here needs to reach the browser.
 */

import {
  CONSOLE_MAX_REQUEST_BYTES,
  CONSOLE_METHODS,
  type ConsoleMethod,
  type ConsoleRequest,
  type Parsed,
} from './console';
import { HOP_BY_HOP } from './rules';

/** How long a test request may take, headers and body together. */
export const CONSOLE_TIMEOUT_MS = 15_000;
/** Most request headers one test request may carry. */
export const CONSOLE_MAX_HEADERS = 50;

/**
 * Request headers the console refuses to set: the transport's own (`Host`,
 * `Content-Length`, hop-by-hop), which fetch computes, and g2way's admin
 * header, which has no business on the data plane.
 */
export const CONSOLE_REFUSED_HEADERS: readonly string[] = [
  'host',
  'content-length',
  'x-g2-authorization',
  ...HOP_BY_HOP,
];

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BAD_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;

function isConsoleMethod(value: string): value is ConsoleMethod {
  return (CONSOLE_METHODS as readonly string[]).includes(value);
}

/** Validates a console request body from the browser. Every refusal names what is wrong. */
export function parseConsoleRequest(json: unknown): Parsed<ConsoleRequest> {
  const fail = (error: string): Parsed<ConsoleRequest> => ({ ok: false, error });
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return fail('invalid console request: expected a JSON object');
  }
  const input = json as Record<string, unknown>;
  const { apiId, method, path, headers, body, version } = input;
  if (typeof apiId !== 'string' || apiId === '') return fail('invalid console request: apiId');
  if (typeof method !== 'string' || !isConsoleMethod(method.toUpperCase())) {
    return fail(`invalid console request: method must be one of ${CONSOLE_METHODS.join(', ')}`);
  }
  if (typeof path !== 'string') return fail('invalid console request: path must be a string');
  if (typeof body !== 'string') return fail('invalid console request: body must be a string');
  if (new TextEncoder().encode(body).byteLength > CONSOLE_MAX_REQUEST_BYTES) {
    return fail(`request body over the console's ${CONSOLE_MAX_REQUEST_BYTES}-byte cap`);
  }
  if (
    version !== null &&
    version !== undefined &&
    (typeof version !== 'string' || version === '')
  ) {
    return fail('invalid console request: version must be a non-empty string or null');
  }
  if (!Array.isArray(headers)) return fail('invalid console request: headers must be a list');
  if (headers.length > CONSOLE_MAX_HEADERS) {
    return fail(`at most ${CONSOLE_MAX_HEADERS} request headers`);
  }
  const pairs: [string, string][] = [];
  for (const entry of headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string'
    ) {
      return fail('invalid console request: each header is a [name, value] pair');
    }
    const [name, value] = entry as [string, string];
    if (!HEADER_NAME.test(name)) return fail(`not a valid header name: ${JSON.stringify(name)}`);
    if (BAD_HEADER_VALUE.test(value)) return fail(`header ${name}: value has control characters`);
    if (CONSOLE_REFUSED_HEADERS.includes(name.toLowerCase())) {
      return fail(`header ${name} cannot be set from the console`);
    }
    pairs.push([name, value]);
  }
  return {
    ok: true,
    value: {
      apiId,
      method: method.toUpperCase() as ConsoleMethod,
      path,
      headers: pairs,
      body,
      version: typeof version === 'string' ? version : null,
    },
  };
}

/** Where a test request goes: the URL to fetch, and the path and query the gateway sees. */
export type ConsoleTarget = { url: URL; path: string; query: string };

/** The listen path without its trailing slashes (`/` stays `/`'s empty prefix). */
function listenBase(listenPath: string): string {
  return listenPath.replace(/\/+$/, '');
}

/**
 * The SSRF guard (ADR-0011 §2). The URL is always the environment's
 * configured proxy base, plus the API's listen path, plus `suffix`; nothing
 * the browser sends can change the scheme, host or port, and the resolved
 * path must still sit under the listen path once `.`/`..` segments (plain
 * or percent-encoded) are resolved. Encoded slashes and backslashes, control
 * characters and fragments are refused outright, since servers disagree on
 * what they mean.
 */
export function consoleTarget(
  proxyBase: string,
  listenPath: string,
  suffix: string,
): Parsed<ConsoleTarget> {
  const fail = (error: string): Parsed<ConsoleTarget> => ({ ok: false, error });
  if (/[\x00-\x20\x7f\\#]/.test(suffix)) {
    return fail('path: spaces, control characters, backslashes and # are not allowed');
  }
  if (/%(2f|5c|00)/i.test(suffix)) return fail('path: encoded slashes and NULs are not allowed');
  let base: URL;
  try {
    base = new URL(proxyBase);
  } catch {
    return fail('the proxy URL is not a valid URL');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const listen = listenBase(listenPath);
  const at = suffix.indexOf('?');
  const rest = (at === -1 ? suffix : suffix.slice(0, at)).replace(/^\/+/, '');
  const query = at === -1 ? '' : suffix.slice(at + 1);
  const path = rest !== '' ? `${listen}/${rest}` : listenPath.endsWith('/') ? `${listen}/` : listen;
  let url: URL;
  try {
    url = new URL(`${base.origin}${prefix}${path === '' ? '/' : path}${query ? `?${query}` : ''}`);
  } catch {
    return fail('path: not a valid URL path');
  }
  const seen = url.pathname.slice(prefix.length);
  const under = listen === '' || seen === listen || seen.startsWith(`${listen}/`);
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !under) {
    return fail(`path: must stay under the API's listen path ${listenPath}`);
  }
  return { ok: true, value: { url, path: seen === '' ? '/' : seen, query: url.search.slice(1) } };
}

/** Whether a `Content-Type` names text the console can show. */
export function isTextual(contentType: string | null): boolean {
  if (contentType === null || contentType === '') return true;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    type.startsWith('text/') ||
    /[/+](json|xml|yaml|javascript|x-www-form-urlencoded|graphql)$/.test(type) ||
    type === 'application/problem+json'
  );
}

/** g2way's `{"error": "..."}` message when `body` is exactly that envelope, else `null`. */
export function gatewayErrorOf(body: string): string | null {
  try {
    const json: unknown = JSON.parse(body);
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    const keys = Object.keys(json);
    const error = (json as Record<string, unknown>).error;
    return keys.length === 1 && typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
}
