import type { JsonValue } from '@/lib/db/schema/shared';

/**
 * Redaction for audit snapshots (ADR-0006 §4). Universal and dependency-free:
 * the data layer runs every `before`, `after` and `request` through
 * {@link redactSnapshot} before storing it, so no caller can forget to.
 *
 * What counts as a secret, from `contracts/g2way.d.ts`:
 * - `hmac.secret` (a live HMAC credential stored in plaintext),
 * - `basic_auth.password_hash`, JWT `secret`,
 * - credential-bearing header values (`transform_headers.*.add`,
 *   `schema_sync.headers`, data-source `headers`: `Authorization: Bearer …`),
 * - the raw key in `POST /g2/keys`'s 201 body, which the caller strips with
 *   {@link REDACTED_RAW_KEY} because `key` alone is also an ordinary field name
 *   (`versioning.key`).
 *
 * The rule is by property name, at any depth: a non-null, non-boolean value
 * under a name matching {@link SENSITIVE_NAME} is replaced. That errs on the
 * side of hiding: a cookie *name* (`auth.cookie`) is hidden along with cookie
 * values. Booleans pass (`allow_credentials` is not a secret).
 */

export const REDACTED = '[redacted]';
/** Marks a redacted value that differs from the one in the other snapshot. */
export const REDACTED_CHANGED = '[redacted: changed]';
export const REDACTED_RAW_KEY = '[redacted: raw key, shown once to its creator]';

/** Property names whose values are secrets, anywhere in a snapshot. */
export const SENSITIVE_NAME =
  /secret|passw|token|authorization|cookie|api[-_]?key|private[-_]?key|signature|credential|session[-_]?id/i;

function isRecord(value: JsonValue | null | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sensitive(name: string, value: JsonValue): boolean {
  return value !== null && typeof value !== 'boolean' && SENSITIVE_NAME.test(name);
}

/**
 * `value` with every secret replaced. When `compareTo` is the same resource's
 * other snapshot, a secret that differs from its counterpart there becomes
 * {@link REDACTED_CHANGED}, so a diff still shows *that* it changed, never what
 * to.
 */
export function redactSnapshot(value: JsonValue, compareTo?: JsonValue | null): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactSnapshot(item, Array.isArray(compareTo) ? compareTo[i] : undefined),
    );
  }
  if (!isRecord(value)) return value;
  const other = isRecord(compareTo) ? compareTo : null;
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => {
      const counterpart = other !== null && Object.hasOwn(other, name) ? other[name] : undefined;
      if (!sensitive(name, child)) return [name, redactSnapshot(child, counterpart)];
      const changed =
        counterpart !== undefined &&
        counterpart !== null &&
        JSON.stringify(counterpart) !== JSON.stringify(child);
      return [name, changed ? REDACTED_CHANGED : REDACTED];
    }),
  );
}

/** Snapshots larger than this (as JSON) are not stored; the row notes it instead. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** `value`, or `null` and a note when its JSON is over {@link MAX_SNAPSHOT_BYTES}. */
export function capSnapshot(
  label: string,
  value: JsonValue | null,
): { value: JsonValue | null; note?: string } {
  if (value === null) return { value };
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size <= MAX_SNAPSHOT_BYTES) return { value };
  return {
    value: null,
    note: `${label} not stored: ${size} bytes is over the ${MAX_SNAPSHOT_BYTES}-byte snapshot limit`,
  };
}
