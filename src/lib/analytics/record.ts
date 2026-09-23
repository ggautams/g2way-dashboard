/**
 * g2way's per-request analytics record, as its Redis-list sink writes it
 * (ADR-0012 §4).
 *
 * **Hand-typed.** `AnalyticsRecord` is not in g2way's OpenAPI document (no admin
 * endpoint returns it), so `contracts/g2way.d.ts` has no type for it. This
 * mirrors `crates/g2-core/src/analytics.rs`, which the `analytics` area in
 * `contracts/watch.json` watches. UPSTREAM.md asks for the schema; when
 * `g2way.d.ts` gains it, `record.test.ts` fails and this type should become an
 * alias of the generated one, keeping only the parser.
 *
 * Serde semantics carried over: optional fields are omitted when absent and
 * tolerated when missing; unknown fields are ignored (the struct has no
 * `deny_unknown_fields`), so a newer gateway's extra fields are not an error.
 */
export type AnalyticsRecord = {
  /** When the request arrived at the gateway (Unix epoch, milliseconds). */
  timestamp_unix_ms: number;
  /** The `api_id` of the matched API definition. */
  api_id: string;
  /** The organization owning the matched API. */
  org_id: string;
  /** HTTP request method. */
  method: string;
  /** Request path as received from the client, without the query string. */
  path: string;
  /** HTTP response status sent to the client. */
  status: number;
  /** Total time to answer the client, gateway overhead included (ms). */
  latency_ms: number;
  /** Upstream round trip (ms); absent for requests rejected inside the gateway. */
  upstream_latency_ms?: number;
  /** SHA-256 hex digest of the authenticated key; absent for keyless and rejected requests. */
  key_hash?: string;
  /** The authenticated key session's alias, when set. */
  key_alias?: string;
  /** The client's remote IP address. Read by nothing here (ADR-0012 §6). */
  client_ip?: string;
  /** The request's `User-Agent`. Read by nothing here (ADR-0012 §6). */
  user_agent?: string;
  /** The request's numeric `Content-Length`, when present. */
  request_content_length?: number;
  /** The response's numeric `Content-Length`, when present. */
  response_content_length?: number;
};

/**
 * The Redis list g2way's `redis` analytics sink appends to for `orgId`
 * (`analytics_records_key` in `crates/g2-core/src/analytics.rs`).
 */
export function analyticsRecordsKey(orgId: string): string {
  return `g2:${orgId}:analytics:records`;
}

export type ParsedRecord = { ok: true; record: AnalyticsRecord } | { ok: false; reason: string };

const REQUIRED_STRINGS = ['api_id', 'org_id', 'method', 'path'] as const;
const REQUIRED_UINTS = ['timestamp_unix_ms', 'latency_ms'] as const;
const OPTIONAL_STRINGS = ['key_hash', 'key_alias', 'client_ip', 'user_agent'] as const;
const OPTIONAL_UINTS = [
  'upstream_latency_ms',
  'request_content_length',
  'response_content_length',
] as const;

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses one list element. `expectedOrg` is the org whose list it came from: a
 * record naming another org is refused, since the dashboard only ever writes
 * rows for its configured org (ADR-0007). The reason never quotes the element,
 * which carries client IPs and paths.
 */
export function parseAnalyticsRecord(raw: string, expectedOrg: string): ParsedRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  const fields = value as Record<string, unknown>;
  for (const name of REQUIRED_STRINGS) {
    if (typeof fields[name] !== 'string') return { ok: false, reason: `${name} is not a string` };
  }
  for (const name of REQUIRED_UINTS) {
    if (!isUint(fields[name])) return { ok: false, reason: `${name} is not an unsigned integer` };
  }
  const status = fields.status;
  if (!isUint(status) || status > 65535) {
    return { ok: false, reason: 'status is not an unsigned 16-bit integer' };
  }
  for (const name of OPTIONAL_STRINGS) {
    const field = fields[name];
    if (field !== undefined && field !== null && typeof field !== 'string') {
      return { ok: false, reason: `${name} is not a string` };
    }
  }
  for (const name of OPTIONAL_UINTS) {
    const field = fields[name];
    if (field !== undefined && field !== null && !isUint(field)) {
      return { ok: false, reason: `${name} is not an unsigned integer` };
    }
  }
  if (fields.org_id !== expectedOrg) {
    return { ok: false, reason: 'org_id is not the configured org' };
  }

  const record: AnalyticsRecord = {
    timestamp_unix_ms: fields.timestamp_unix_ms as number,
    api_id: fields.api_id as string,
    org_id: fields.org_id,
    method: fields.method as string,
    path: fields.path as string,
    status,
    latency_ms: fields.latency_ms as number,
  };
  // serde's `Option` reads `null` as `None`: keep the absence, drop the null.
  for (const name of OPTIONAL_STRINGS) {
    const field = fields[name];
    if (typeof field === 'string') record[name] = field;
  }
  for (const name of OPTIONAL_UINTS) {
    const field = fields[name];
    if (isUint(field)) record[name] = field;
  }
  return { ok: true, record };
}
