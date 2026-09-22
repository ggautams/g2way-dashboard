import type { JsonValue } from '@/lib/db/schema/shared';
import { SECRET_KINDS, mapSecrets, type SecretKind } from '@/lib/secrets/redact';
import { looksLikeUrl, maskUrlCredentials } from '@/lib/secrets/url';

/**
 * Redaction for audit snapshots (ADR-0006 §4). Universal and dependency-free:
 * the data layer runs every `before`, `after` and `request` through
 * {@link redactSnapshot} before storing it, so no caller can forget to.
 *
 * Three rules, applied together in one walk:
 * - **ADR-0010's typed path lists** (`SECRET_PATHS`) for the snapshot's kind:
 *   `hmac.secret`, `basic_auth.password_hash`, JWT `auth.secret` and every
 *   upstream-bound header map as a whole (`transform_headers.request.add`,
 *   schema sync, UDG data sources, subgraphs, and per version). So an
 *   `X-Upstream-Key` is hidden although its name is not credential-like.
 * - **The name rule**, at any depth: a non-null, non-boolean value under a
 *   name matching {@link SENSITIVE_NAME} is replaced. It errs toward hiding (a
 *   cookie _name_ such as `auth.cookie` goes too) and covers what no path
 *   types: plugin `config`, response headers, fields upstream adds later.
 * - **Credentials inside URLs** (ADR-0010 §3): the userinfo and credential
 *   query parameters of the typed URL fields (`target_url`, `schema_sync.url`,
 *   UDG and subgraph `url`, …) and of any other `scheme://…` string become
 *   {@link REDACTED_URL}; host, path and the other parameters stay.
 *
 * The raw key in `POST /g2/keys`'s 201 body is stripped by the caller with
 * {@link REDACTED_RAW_KEY}, because `key` alone is also an ordinary field name
 * (`versioning.key`).
 *
 * Config history (`config_versions`, ADR-0008) is deliberately **not** run
 * through this: rollback restores the real values (ADR-0010 §4).
 */

export const REDACTED = '[redacted]';
/** Marks a redacted value that differs from the one in the other snapshot. */
export const REDACTED_CHANGED = '[redacted: changed]';
export const REDACTED_RAW_KEY = '[redacted: raw key, shown once to its creator]';
/** {@link REDACTED} inside a URL, percent-encoded so the URL still parses. */
export const REDACTED_URL = encodeURIComponent(REDACTED);
/** {@link REDACTED_CHANGED} inside a URL. */
export const REDACTED_CHANGED_URL = encodeURIComponent(REDACTED_CHANGED);

/** Property names whose values are secrets, anywhere in a snapshot. */
export const SENSITIVE_NAME =
  /secret|passw|token|authorization|cookie|api[-_]?key|private[-_]?key|signature|credential|session[-_]?id/i;

/**
 * The gateway kind an audit action's snapshots hold (`api.update` → `api`).
 * `null` for anything else (users, sign-ins, reloads, bulk summaries), whose
 * snapshots are checked against every kind's paths: stricter, never looser.
 */
export function snapshotKind(action: string): SecretKind | null {
  const prefix = action.slice(0, action.indexOf('.'));
  return prefix === 'api' || prefix === 'policy' || prefix === 'key' ? prefix : null;
}

function differs(value: JsonValue, counterpart: JsonValue | undefined): boolean {
  return (
    counterpart !== undefined &&
    counterpart !== null &&
    JSON.stringify(counterpart) !== JSON.stringify(value)
  );
}

/** `url` with its credentials hidden; marked changed when only they differ from `counterpart`. */
function redactUrl(url: string, counterpart: JsonValue | undefined): string {
  const masked = maskUrlCredentials(url, REDACTED_URL);
  if (masked === url) return url;
  const credentialsChanged =
    typeof counterpart === 'string' &&
    counterpart !== url &&
    maskUrlCredentials(counterpart, REDACTED_URL) === masked;
  return credentialsChanged ? maskUrlCredentials(url, REDACTED_CHANGED_URL) : masked;
}

/**
 * `value` with every secret replaced. When `compareTo` is the same resource's
 * other snapshot, a secret that differs from its counterpart there becomes
 * {@link REDACTED_CHANGED} (in a URL, {@link REDACTED_CHANGED_URL}), so a diff
 * still shows _that_ it changed, never what to. `kind` picks the typed paths;
 * `null` (the default) applies every kind's.
 */
export function redactSnapshot(
  value: JsonValue,
  compareTo?: JsonValue | null,
  kind: SecretKind | null = null,
): JsonValue {
  return mapSecrets(
    kind === null ? SECRET_KINDS : [kind],
    value,
    compareTo,
    (node, counterpart, site) => {
      if (node === null || typeof node === 'boolean') return undefined;
      const byName = site.name !== null && SENSITIVE_NAME.test(site.name);
      const byPath = site.secretPath && (typeof node === 'string' || typeof node === 'number');
      if (byName || byPath) return differs(node, counterpart) ? REDACTED_CHANGED : REDACTED;
      if (typeof node === 'string' && (site.urlPath || looksLikeUrl(node))) {
        return redactUrl(node, counterpart);
      }
      return undefined;
    },
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
