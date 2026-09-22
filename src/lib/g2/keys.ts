import 'server-only';

import type { Role } from '@/lib/auth/rbac';
import { redactFor } from '@/lib/secrets/redact';
import { matchKey, scanOrder, type KeyFilter, type KeyLabels } from '@/lib/keys/filter';
import {
  pageOf,
  parseKeyList,
  summariseKey,
  type KeySession,
  type Paged,
} from '@/lib/keys/session';
import { summarisePolicy } from '@/lib/policies/list';
import { unwrap } from './client';
import { resolveEnvironment } from './environments';
import { settle, type Outcome } from './gateway-status';
import { loadPolicies } from './policies';
import { gatewayClient, type GatewayClientDeps } from './server-client';

/**
 * Keys as the gateway stores them. `GET /g2/keys` lists hashes only, so
 * everything a row shows (alias, state, expiry, policy) costs one
 * `GET /g2/keys/{hash}?hashed=true` per key. The list therefore pages: at most
 * {@link KEY_PAGE_SIZE} session reads per view, {@link READ_CONCURRENCY} at a
 * time. A search ({@link loadKeySearch}) reads sessions too, bounded by
 * {@link KEY_SCAN_LIMIT}.
 */

export const KEY_PAGE_SIZE = 25;
export const READ_CONCURRENCY = 5;
/**
 * The most sessions one search reads. Alias, policy and state are only in the
 * session, so a search over more keys than this is incomplete and says so;
 * label/owner matches are read first, so those are covered up to this many.
 */
export const KEY_SCAN_LIMIT = 200;

export type KeyRow = { hash: string; session: Outcome<KeySession> };
export type KeyPage = {
  environment: string;
  /** `hashes`: every hash `GET /g2/keys` listed, for orphan detection. */
  keys: Outcome<Paged<KeyRow> & { hashes: string[] }>;
  /** Unix milliseconds when the list was read: expiry is judged against it. */
  fetchedAt: number;
};

/** Maps `items` through `work`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Page `page` (1-based, clamped) of environment `environmentId`'s keys, each
 * with its session. Registry errors are thrown; gateway and network failures
 * are settled, per key for the session reads, so one bad record does not blank
 * the page.
 */
export async function loadKeyPage(
  environmentId: string | undefined,
  page: number,
  deps: GatewayClientDeps & { now?: () => number } = {},
): Promise<KeyPage> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  const fetchedAt = (deps.now ?? Date.now)();
  const keys = await settle(async () => {
    const hashes = parseKeyList(await unwrap(client.GET('/g2/keys')));
    const shown = pageOf(hashes, page, KEY_PAGE_SIZE);
    const rows = await mapLimit(shown.items, READ_CONCURRENCY, async (hash) => ({
      hash,
      session: await readSession(client, hash),
    }));
    return { ...shown, items: rows, hashes };
  });
  return { environment: id, keys, fetchedAt };
}

/** One session read by hash, settled. */
function readSession(client: ReturnType<typeof gatewayClient>, hash: string) {
  return settle(() =>
    unwrap(
      client.GET('/g2/keys/{key}', { params: { path: { key: hash }, query: { hashed: true } } }),
    ),
  );
}

export type KeySearchScan = {
  /** Keys the gateway lists. */
  total: number;
  /** Sessions read (at most {@link KEY_SCAN_LIMIT}). */
  scanned: number;
  /** Matches among the keys read, before paging. */
  matched: number;
  /** Keys whose session read failed and whose match depends on it: listed, unchecked. */
  unchecked: number;
};

export type KeySearch = {
  environment: string;
  /** The page of matching rows (and the unchecked ones), with how far the search got. */
  keys: Outcome<Paged<KeyRow> & { hashes: string[]; scan: KeySearchScan }>;
  /** The dashboard's labels for every listed hash; a failure leaves label/owner unsearched. */
  labels: Outcome<Map<string, KeyLabels>>;
  fetchedAt: number;
};

/**
 * Searches environment `environmentId`'s keys with `filter` and returns page
 * `page` of the matches. Label and owner come from `labelsFor` (the dashboard
 * database, one query); alias, policy and state cost a session read per key,
 * in {@link scanOrder}, at most {@link KEY_SCAN_LIMIT} of them,
 * {@link READ_CONCURRENCY} at a time. Registry errors are thrown; gateway and
 * database failures are settled.
 */
export async function loadKeySearch(
  environmentId: string | undefined,
  filter: KeyFilter,
  page: number,
  deps: GatewayClientDeps & {
    now?: () => number;
    labelsFor: (environment: string, hashes: readonly string[]) => Promise<Map<string, KeyLabels>>;
  },
): Promise<KeySearch> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  const fetchedAt = (deps.now ?? Date.now)();
  const nowSecs = Math.floor(fetchedAt / 1000);
  let labels: Outcome<Map<string, KeyLabels>> = { ok: true, value: new Map() };
  const keys = await settle(async () => {
    const hashes = parseKeyList(await unwrap(client.GET('/g2/keys')));
    try {
      labels = { ok: true, value: await deps.labelsFor(id, hashes) };
    } catch (error) {
      labels = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const known = labels.ok ? labels.value : new Map<string, KeyLabels>();
    const order = scanOrder(hashes, known, filter.q).slice(0, KEY_SCAN_LIMIT);
    const rows = await mapLimit(order, READ_CONCURRENCY, async (hash) => ({
      hash,
      session: await readSession(client, hash),
    }));
    let matched = 0;
    let unchecked = 0;
    const shown = rows.filter((row) => {
      const verdict = matchKey(
        {
          hash: row.hash,
          labels: known.get(row.hash),
          summary: row.session.ok ? summariseKey(row.hash, row.session.value) : null,
        },
        filter,
        nowSecs,
      );
      if (verdict === 'match') matched += 1;
      if (verdict === 'unknown') unchecked += 1;
      return verdict !== 'no';
    });
    return {
      ...pageOf(shown, page, KEY_PAGE_SIZE),
      hashes,
      scan: { total: hashes.length, scanned: rows.length, matched, unchecked },
    };
  });
  return { environment: id, keys, labels, fetchedAt };
}

/** Every hash `GET /g2/keys` lists in `environmentId`, settled: orphan detection's input. */
export async function loadKeyHashes(
  environmentId: string | undefined,
  deps: GatewayClientDeps = {},
): Promise<{ environment: string; hashes: Outcome<string[]> }> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return {
    environment: id,
    hashes: await settle(async () => parseKeyList(await unwrap(client.GET('/g2/keys')))),
  };
}

export type KeyItem = {
  environment: string;
  session: Outcome<KeySession>;
  /** Unix milliseconds when the session was read: expiry is judged against it. */
  fetchedAt: number;
};

/**
 * One session by hash (`GET /g2/keys/{hash}?hashed=true`), as `role` may see
 * it: `hmac.secret` and `basic_auth.password_hash` masked without `keys:write`
 * (ADR-0010). A 404 settles with `status: 404`.
 */
export async function loadKey(
  environmentId: string | undefined,
  hash: string,
  role: Role,
  deps: GatewayClientDeps & { now?: () => number } = {},
): Promise<KeyItem> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  const fetchedAt = (deps.now ?? Date.now)();
  return {
    environment: id,
    fetchedAt,
    session: await settle(async () =>
      redactFor(
        role,
        'key',
        await unwrap(
          client.GET('/g2/keys/{key}', {
            params: { path: { key: hash }, query: { hashed: true } },
          }),
        ),
      ),
    ),
  };
}

export type PolicyChoices =
  | { ok: true; value: { id: string; name: string; active: boolean }[] }
  | { ok: false; error: string };

/** The policies a key may apply in `environmentId`, for the designer's select. */
export async function loadPolicyChoices(
  environmentId: string | undefined,
  deps: GatewayClientDeps = {},
): Promise<PolicyChoices> {
  const { policies } = await loadPolicies(environmentId, deps);
  if (!policies.ok) {
    return {
      ok: false,
      error:
        policies.status === undefined
          ? policies.error
          : `${policies.error} (HTTP ${policies.status})`,
    };
  }
  return {
    ok: true,
    value: policies.value.map((policy) => {
      const summary = summarisePolicy(policy);
      return { id: summary.policyId, name: summary.name, active: summary.active };
    }),
  };
}
