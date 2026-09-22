import 'server-only';

import { can, type Role } from '@/lib/auth/rbac';
import { isFiltering, parseKeyFilter, type KeyFilter, type KeyLabels } from '@/lib/keys/filter';
import { toKeyListRow } from '@/lib/keys/list-row';
import type { KeyMatchSelection } from '@/lib/keys/matches';
import { RegistryConfigError, UnknownEnvironmentError } from './environments';
import { KEY_SCAN_LIMIT, loadKeyMatches, type KeyMatches } from './keys';
import type { GatewayClientDeps } from './server-client';

/**
 * Resolves "select every match" on `/keys` (M4): the whole match set of a
 * filter, through {@link loadKeyMatches}, the search loader's own scan, so the
 * same {@link KEY_SCAN_LIMIT} cap, truncation report and unchecked rule apply.
 * A read only; the bulk action that follows goes through `POST /api/g2/bulk`,
 * audited per item there.
 *
 * Only display rows reach the browser (`toKeyListRow`), never sessions: a
 * session can hold an hmac secret. Keys whose session read failed are never
 * selected, and the answer counts them.
 */
export async function resolveKeyMatches(
  actor: { role: Role },
  environmentId: string,
  input: unknown,
  deps: GatewayClientDeps & {
    now?: () => number;
    labelsFor: (environment: string, hashes: readonly string[]) => Promise<Map<string, KeyLabels>>;
  },
): Promise<KeyMatchSelection> {
  if (!can(actor.role, 'keys:write')) {
    return {
      ok: false,
      error: `forbidden: the ${actor.role} role lacks the keys:write permission`,
    };
  }
  const filter = filterFrom(input);
  if (filter === null || !isFiltering(filter)) {
    return { ok: false, error: 'select every match needs a search or filter' };
  }
  let found: KeyMatches;
  try {
    found = await loadKeyMatches(environmentId, filter, deps);
  } catch (error) {
    if (error instanceof UnknownEnvironmentError || error instanceof RegistryConfigError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  const { keys, labels, fetchedAt, environment } = found;
  if (!keys.ok) {
    return {
      ok: false,
      error: `GET /g2/keys failed: ${keys.error}${keys.status === undefined ? '' : ` (HTTP ${keys.status})`}`,
    };
  }
  const known = labels.ok ? labels.value : new Map<string, KeyLabels>();
  const nowSecs = Math.floor(fetchedAt / 1000);
  const { matches, unreadable, scan } = keys.value;
  return {
    ok: true,
    environment,
    items: matches.map(({ hash, session }) =>
      toKeyListRow(hash, { ok: true, value: session }, known.get(hash), nowSecs),
    ),
    scan,
    unreadable,
    truncatedAt: scan.scanned < scan.total ? KEY_SCAN_LIMIT : null,
    labelsError: labels.ok ? null : labels.error,
    resolvedAt: fetchedAt,
  };
}

/** The `{q, policy, state}` a server action received, checked; `null` if malformed. */
function filterFrom(input: unknown): KeyFilter | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const params: Record<string, string> = {};
  for (const name of ['q', 'policy', 'state'] as const) {
    const value = (input as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    params[name] = value;
  }
  return parseKeyFilter(params);
}
