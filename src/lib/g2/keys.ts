import 'server-only';

import { pageOf, parseKeyList, type KeySession, type Paged } from '@/lib/keys/session';
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
 * time. Searching by alias needs every session, which is why it waits for the
 * dashboard's own key metadata (M4).
 */

export const KEY_PAGE_SIZE = 25;
const READ_CONCURRENCY = 5;

export type KeyRow = { hash: string; session: Outcome<KeySession> };
export type KeyPage = {
  environment: string;
  keys: Outcome<Paged<KeyRow>>;
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
      session: await settle(() =>
        unwrap(
          client.GET('/g2/keys/{key}', {
            params: { path: { key: hash }, query: { hashed: true } },
          }),
        ),
      ),
    }));
    return { ...shown, items: rows };
  });
  return { environment: id, keys, fetchedAt };
}

export type KeyItem = {
  environment: string;
  session: Outcome<KeySession>;
  /** Unix milliseconds when the session was read: expiry is judged against it. */
  fetchedAt: number;
};

/** One session by hash (`GET /g2/keys/{hash}?hashed=true`); a 404 settles with `status: 404`. */
export async function loadKey(
  environmentId: string | undefined,
  hash: string,
  deps: GatewayClientDeps & { now?: () => number } = {},
): Promise<KeyItem> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  const fetchedAt = (deps.now ?? Date.now)();
  return {
    environment: id,
    fetchedAt,
    session: await settle(() =>
      unwrap(
        client.GET('/g2/keys/{key}', { params: { path: { key: hash }, query: { hashed: true } } }),
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
