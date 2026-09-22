/**
 * Orphaned key metadata (ADR-0009 §7): `key_metadata` rows whose hash the
 * gateway no longer lists. The dashboard drops a key's row when it deletes the
 * key itself; a delete made anywhere else (the g2way CLI, another tool, a
 * Redis flush) leaves the row behind, describing a key that does not exist.
 *
 * The rule is deliberately one-sided: a key counts as gone only when
 * `GET /g2/keys` **succeeded** and does not list its hash. A failed or
 * unreadable list proves nothing, so it yields no orphans at all, never "all
 * of them". Universal and pure.
 */

/** What `GET /g2/keys` gave: the hashes, or why there are none to compare with. */
export type ListedHashes =
  { ok: true; value: readonly string[] } | { ok: false; error: string; status?: number };

export type OrphanCheck<T> = { ok: true; orphans: T[] } | { ok: false; error: string };

/** The rows among `rows` whose `keyHash` the gateway's successful list does not contain. */
export function findOrphans<T extends { keyHash: string }>(
  listed: ListedHashes,
  rows: readonly T[],
): OrphanCheck<T> {
  if (!listed.ok) {
    return {
      ok: false,
      error: `GET /g2/keys failed, so no key can be judged gone: ${listed.error}${listed.status === undefined ? '' : ` (HTTP ${listed.status})`}`,
    };
  }
  const present = new Set(listed.value);
  return { ok: true, orphans: rows.filter((row) => !present.has(row.keyHash)) };
}

/** What the prune action answers the form. */
export type PruneOrphansState = {
  error: string | null;
  notice?: string;
  /** Hashes whose rows were removed. */
  pruned?: string[];
  /** Hashes asked for but kept, and why. */
  kept?: { hash: string; reason: string }[];
};

export const PRUNE_IDLE: PruneOrphansState = { error: null };
