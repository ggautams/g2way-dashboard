/**
 * The request console's contract (ADR-0011): what the browser asks the BFF to
 * send through the gateway's proxy listener, what it gets back, and the pure
 * guard that decides where a test request may go.
 *
 * Universal: the console component (`request-console.tsx`) builds and posts
 * requests with it. The BFF's parsing and SSRF guard live in
 * `console-guard.ts`, which no client component imports. Neither the proxy
 * URL nor the admin secret appears here: the browser only ever names a path
 * under the API's own listen path.
 */

import { GatewayError } from '@/lib/g2/errors';
import { ENVIRONMENT_HEADER } from '@/lib/g2/client';
import type { Trace } from './trace';

/** The console's BFF route, under `/api` (`src/app/api/g2/console/route.ts`). */
export const CONSOLE_PATH = '/g2/console';

/** Methods the console sends. `CONNECT` and `TRACE` are not test requests. */
export const CONSOLE_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
export type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** Largest request body the console sends (bytes of UTF-8). */
export const CONSOLE_MAX_REQUEST_BYTES = 1_048_576;
/** How much of the response body the BFF reads and passes on; the rest is dropped. */
export const CONSOLE_MAX_RESPONSE_BYTES = 65_536;
export type ConsoleRequest = {
  apiId: string;
  method: ConsoleMethod;
  /** What follows the listen path: `users/42?full=1`. May be empty. */
  path: string;
  /** Header name/value pairs, in order; names are case-insensitive. */
  headers: [string, string][];
  /** Sent as the body unless the method is GET or HEAD. */
  body: string;
  /**
   * For a versioned API: the version to ask for, set by the BFF where the
   * definition's selector reads it (header or query parameter). `null` sends
   * none, so the gateway's default applies.
   */
  version: string | null;
};

/** The console's answer, as the BFF returns it (the proxy URL is never part of it). */
/** A parse result: the value, or why it was refused. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type ConsoleAnswer = {
  environment: string;
  /** What was sent: the path and query as the gateway saw them, and header names only. */
  sent: { method: ConsoleMethod; path: string; query: string; headerNames: string[] };
  response: {
    status: number;
    statusText: string;
    headers: [string, string][];
    /** The body as text, cut at {@link CONSOLE_MAX_RESPONSE_BYTES}; empty for a binary body. */
    body: string;
    /** Bytes read, up to the cap plus one (so `truncated` can be told). */
    bytes: number;
    truncated: boolean;
    /** The body is not text (by its `Content-Type`), so it is not shown. */
    binary: boolean;
    /** g2way's `{"error": "..."}` message, verbatim, when the body is that envelope. */
    gatewayError: string | null;
  };
  /** Milliseconds until the response headers arrived, and until the (capped) body was read. */
  timing: { headersMs: number; totalMs: number };
  trace: Trace;
};

/**
 * The console's header box: one `Name: value` per line, in order, duplicates
 * kept (a request may repeat a header). Blank lines are skipped.
 */
export function parseHeaderText(text: string): Parsed<[string, string][]> {
  const pairs: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.indexOf(':');
    if (at <= 0) return { ok: false, error: `Write each header as Name: value — ${line}` };
    pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { ok: true, value: pairs };
}

export type ConsoleResult =
  ({ ok: true } & ConsoleAnswer) | { ok: false; error: string; status?: number };

/**
 * Sends `request` through the BFF for `environmentId`. A failure carries the
 * BFF's or the gateway's `{"error"}` message verbatim.
 */
export async function postConsoleRequest(
  environmentId: string,
  request: ConsoleRequest,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<ConsoleResult> {
  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.baseUrl ?? '/api'}${CONSOLE_PATH}`, {
      method: 'POST',
      headers: {
        [ENVIRONMENT_HEADER]: environmentId,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { message, status } = GatewayError.fromBody(response.status, body);
    return { ok: false, error: message, status };
  }
  if (typeof body !== 'object' || body === null || !('trace' in body) || !('response' in body)) {
    return { ok: false, error: `the console answered ${response.status} without a response` };
  }
  return { ok: true, ...(body as ConsoleAnswer) };
}
