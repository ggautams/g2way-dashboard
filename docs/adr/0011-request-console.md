# ADR-0011: The request console

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0005, ADR-0006, ADR-0007, ADR-0010

## Context

M5's last task is a request console on the API designer: send a test request
through the gateway, show the response, and show which middleware acted on it.
Four things in the existing design do not cover it:

- The environment registry knows only the **admin** listener. g2way serves
  API traffic on a separate proxy listener (`G2_LISTEN`, `0.0.0.0:8080` in its
  own examples; `docs/g2way-map.md` "Two listeners"), and the admin API has no
  "send a request through this API" endpoint.
- A server that fetches a URL built from browser input is an SSRF primitive.
  The BFF so far only calls the admin API, with paths taken from g2way's own
  OpenAPI document.
- A test request usually carries a real credential (an API key, a JWT, a
  basic-auth password), and ADR-0006 audits every action.
- g2way reports nothing about which layers acted: `AnalyticsRecord` has no
  layer field, rejections carry only `{"error": "..."}`, and there is no debug
  or trace header.

## Decisions

1. **Each environment may name a proxy URL; there is no default.**
   `G2_PROXY_URL` in the single-gateway form and `G2_ENV_<ID>_PROXY_URL` per
   environment (`src/lib/g2/environments.ts`, `.env.example`), validated like
   the admin URL. It is the base URL at which the dashboard _server_ reaches
   the proxy listener, possibly with a path prefix (an ingress mount). It is
   server-only, like the admin URL: `PublicEnvironment` does not carry it, the
   console's answers never include it, and a connection failure reports only
   the error code (`ECONNREFUSED`), not Node's message, which names the host.
   Unlike the admin URL it has no default. The console sends real traffic to
   real upstreams, and a guessed `127.0.0.1:8080` could be a different
   gateway. Unset, the console says it is not configured, and the BFF answers
   409 naming the variable.

2. **The SSRF guard: the browser names a path under the API's listen path,
   nothing else.** `POST /api/g2/console` (`src/lib/g2/console.ts`) takes
   `{apiId, method, path, headers, body, version}`.
   - The URL is always the environment's proxy base, then the **stored**
     `listen_path`, then the browser's suffix. The listen path comes from
     `GET /g2/apis/{id}` on the admin API, never from the browser. The origin
     is fixed by config.
   - `consoleTarget` (`src/lib/apis/console-guard.ts`) refuses control characters,
     spaces, backslashes, `#`, and encoded `/`, `\` or NUL. It resolves `.` and
     `..` segments (plain or percent-encoded) with the WHATWG URL parser. The
     result must keep the proxy's origin and stay under its path prefix and
     the listen path.
   - The method is one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. The
     request body is at most 1 MiB, and GET and HEAD refuse one. There are at
     most 50 headers. `Host`, `Content-Length`, hop-by-hop headers and
     `X-G2-Authorization` are refused. Only the listed headers are sent: never
     the browser's own cookies, and never the admin secret.
   - Redirects are not followed (`redirect: 'manual'`, so a 3xx is shown as
     it came). The call times out after 15 s. At most 64 KiB of the response
     body are read, and the rest is cancelled. Bodies whose `Content-Type` is
     not text are reported by size only.

   The console can reach exactly what any client of the proxy listener can,
   and nothing else.

3. **A new permission, `apis:test`, for editor and up (ADR-0005 amended).** A
   test request is not a read: it reaches a real upstream, may change data
   there, and consumes endpoint rate limits and whatever quota the credential
   carries. So it sits with the roles that may change the API, not with
   viewers. A viewer sees the Console tab explaining this, and the BFF
   refuses it with 403.

4. **Audited as an action, without credentials.** Each console request is an
   `api.test_request` row, targeting the API id. `pending` is written before
   the request is sent and completed after, and if that row cannot be
   written the request is not sent (503), as for gateway writes (ADR-0006
   §5). Refusals are `denied`, recorded best effort. The row records **only**
   the method, the path (no query string), the requested version and the
   status. It never records the query string, any header name or value, or
   the body, because that is where test credentials live (`?api_key=`,
   `Authorization`, cookies, a login body). A note on the row says so. The
   outcome is `success` whenever a response came back, whatever its status.
   The status is in `gateway.status`. `failure` means the proxy listener did
   not answer. `api.test_request` is not one of the write actions that
   derive pending-reload state (`src/lib/db/pending.ts`). Malformed requests
   (400) and an unconfigured environment (409) reach nothing and are not
   audited, like the proxy's malformed requests.

5. **The trace is inferred, and labelled so.** `inferTrace`
   (`src/lib/apis/trace.ts`, pure, run by the BFF on the stored, unredacted
   definition) walks `chainFor(def)`. For a versioned API it resolves the
   version as the dispatcher would (the selector's header or query parameter,
   else the default; missing, unknown or expired are refused), then walks
   that version's inner chain via `applyVersion`. For each slot it says
   `rejected`, `answered`, `possible`, `acted`, `passed`, `skipped`,
   `unknown`, `off` or `not-reached`, with a reason. Each step carries the
   Chain tab's slot id and version, so it links there with `chainAnchor`.
   - **Deterministic predictions** come from the definition and the request:
     - a `block_paths` match, or no `allow_paths` match (403);
     - `ignore_auth_paths` standing auth down;
     - a body over `max_request_body_bytes` (413);
     - no credential where the auth mode reads one (401/403); mtls always
       counts as missing, because the console cannot present a client
       certificate;
     - a matching mock (its status);
     - a CORS preflight the gateway answers;
     - a version the dispatcher refuses.

     Rules are matched first-match-wins, with methods, against the full path
     including the listen path, as `endpoints.rs` does. A prediction the
     status contradicts is a **mismatch**, shown as such. It usually means the
     live route table differs from the stored definition (not reloaded) or a
     pattern matches differently in Rust.

   - **The response adds evidence**:
     - `429` and the `X-RateLimit-*`/`Retry-After` headers point at the rate
       limit slot;
     - `x-g2-cache: hit` at the cache;
     - `Access-Control-Allow-Origin` at CORS;
     - response-side header transforms seen on the response;
     - g2way's `{"error": ...}` envelope (quoted verbatim) marks a gateway
       rejection rather than an upstream answer.
   - **Unknowable slots are `unknown`, never guessed.** These are the IP filter
     (the gateway sees the dashboard server's address, not the user's),
     plugins, GraphQL and the gateway-flag slots. They are only candidates for
     an error nothing deterministic explains. With one candidate it is "most
     likely", and with several each is `possible`.
   - Nothing in the trace echoes a header value or a secret from the
     definition, only names, patterns and rule indexes.

   The console shows the trace's standing limits (`TRACE_LIMITS`) beside it.

6. **The real trace is g2way's to give.** UPSTREAM.md's "No per-request
   middleware trace" asks for an opt-in, admin-authenticated debug header on
   the proxy listener that reports the layers that ran. `trace.test.ts` fails
   when the OpenAPI document gains a trace/debug path or such a header, which
   is the cue to show the gateway's own trace (M5's open box).

## Consequences

- The console needs a second URL per environment, and in k8s a route from the
  dashboard to the proxy Service (which exists, unlike the admin port's).
- A console request costs one admin read (the definition), the test request
  and two audit writes.
- The trace can be wrong. Every verdict is phrased as inference, and the
  cases where it most likely is wrong (a stale route, a Rust-only regex) come
  out as mismatches or `unknown`, not as confident answers.
- Not built:
  - saved or shared requests, a history of past responses, and cURL export;
  - client certificates for mtls APIs;
  - streaming (SSE, WebSocket upgrades), which `redirect: 'manual'` and the
    body cap do not suit;
  - sending the unsaved draft: the gateway only routes stored and reloaded
    definitions, so the console always tests what is stored and says so.
