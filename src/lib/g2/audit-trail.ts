import 'server-only';

import { createHash } from 'node:crypto';
import { REDACTED_RAW_KEY } from '@/lib/audit/redact';
import { getDatabase } from '@/lib/db';
import { completeAudit, recordAudit, type AuditRecord } from '@/lib/db/audit';
import { recordVersion, type VersionWrite } from '@/lib/db/config-versions';
import type { JsonValue } from '@/lib/db/schema/shared';
import { getOrgId } from './environments';

/**
 * How the BFF describes a gateway write in the audit log (ADR-0006 §2): which
 * action it is, what it targets, and the path recorded for it — never a raw API
 * key. The proxy (`./proxy`) does the calls; this module only names things.
 */

/** Collections whose items the gateway serves at `/g2/<collection>/{id}`, and their action noun. */
const COLLECTIONS: Readonly<Record<string, string>> = {
  apis: 'api',
  policies: 'policy',
  keys: 'key',
};

/** Whole-gateway operations with no item. */
const OPERATIONS: Readonly<Record<string, string>> = {
  'POST /g2/reload': 'gateway.reload',
  'POST /g2/graphql/sync': 'graphql.sync',
};

const VERBS: Readonly<Record<string, string>> = {
  POST: 'create',
  PUT: 'update',
  DELETE: 'delete',
};

/** g2way's `hash_key`: hex SHA-256 of the raw key (`crates/g2-core/src/session.rs`). */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export type GatewayWrite = {
  /** e.g. `api.update`, `key.create`, `gateway.reload`. */
  action: string;
  /** The collection (`apis`, `policies`, `keys`) when the operation is on one. */
  collection: string | null;
  /** True for `/g2/<collection>/{id}`. */
  isItem: boolean;
  /** The item's id; for keys, always the key's hash. `null` until a create answers. */
  target: string | null;
  /** The path recorded in the audit row: the real path, a raw key replaced by its hash. */
  recordedPath: string;
  /** Caveats for the row. */
  notes: string[];
};

/**
 * Names the write `method` on `segments` (the decoded path after `/g2/`),
 * matched to spec template `template`, with the request's query `search`.
 */
export function describeGatewayWrite(
  method: string,
  template: string,
  segments: readonly string[],
  search: URLSearchParams,
): GatewayWrite {
  const fixed = OPERATIONS[`${method} ${template}`];
  const collection = Object.hasOwn(COLLECTIONS, segments[0]) ? segments[0] : null;
  const isItem = collection !== null && segments.length === 2;
  const action =
    fixed ??
    (collection !== null && VERBS[method] !== undefined
      ? `${COLLECTIONS[collection]}.${VERBS[method]}`
      : `${method} ${template}`);

  const notes: string[] = [];
  let target: string | null = isItem ? segments[1] : null;
  if (isItem && collection === 'keys' && search.get('hashed') !== 'true') {
    target = hashKey(segments[1]);
    notes.push('the key is recorded by its SHA-256 hash (the gateway key_hash), never raw');
  }
  const recorded = isItem ? [segments[0], target ?? ''] : [...segments];
  return {
    action,
    collection,
    isItem,
    target,
    recordedPath: `/g2/${recorded.map(encodeURIComponent).join('/')}`,
    notes,
  };
}

/**
 * The target a create names in its own request body, before the gateway
 * answers: `api_id` for an API definition, `id` for a policy. Keys get their
 * identity from the gateway.
 */
export function createTargetFromBody(
  collection: string | null,
  body: JsonValue | null,
): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const field = collection === 'apis' ? 'api_id' : collection === 'policies' ? 'id' : null;
  const value = field === null ? undefined : body[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Where a successful create can be read back: the item id the gateway
 * returned (`{"id"}`; for keys `key_hash`, read with `hashed=true`).
 */
export function createdItem(
  collection: string | null,
  response: JsonValue | null,
): { id: string; hashed: boolean } | null {
  if (collection === null) return null;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null;
  const value = collection === 'keys' ? response.key_hash : response.id;
  return typeof value === 'string' && value !== ''
    ? { id: value, hashed: collection === 'keys' }
    : null;
}

/** A gateway response body fit to store: `POST /g2/keys`'s raw key removed. */
export function withoutRawKey(collection: string | null, body: JsonValue | null): JsonValue | null {
  if (collection !== 'keys') return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return Object.hasOwn(body, 'key') ? { ...body, key: REDACTED_RAW_KEY } : body;
}

/** Where the proxy writes audit rows. Injectable for tests. */
export type AuditSink = {
  /** Writes a row; throws if it cannot, which makes a gateway write fail closed. */
  record(record: AuditRecord): Promise<string>;
  /** Rewrites a pending row with the final record. */
  complete(id: string, record: AuditRecord): Promise<void>;
  /**
   * Keeps the version a successful API/policy write produced, unredacted
   * (ADR-0008). Best effort: the write has already happened by then.
   */
  version?(write: VersionWrite): Promise<void>;
};

/** The dashboard database, scoped to the configured org. */
export function databaseAuditSink(): AuditSink {
  return {
    record: (record) => recordAudit(getDatabase(), getOrgId(), record),
    complete: (id, record) => completeAudit(getDatabase(), getOrgId(), id, record),
    version: (write) => recordVersion(getDatabase(), getOrgId(), write),
  };
}

/** Collections whose history is kept (ADR-0008), and their version kind. Keys are not config. */
export const VERSIONED: Readonly<Record<string, 'api' | 'policy'>> = {
  apis: 'api',
  policies: 'policy',
};
