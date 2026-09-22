import 'server-only';

import { can } from '@/lib/auth/rbac';
import { recordAudit, type AuditActor } from '@/lib/db/audit';
import {
  KEY_METADATA_ACTIONS,
  deleteKeyMetadata,
  listAllKeyMetadata,
  type KeyMetadata,
} from '@/lib/db/key-metadata';
import type { DataHandle } from '@/lib/db/users';
import { findOrphans, type OrphanCheck, type PruneOrphansState } from '@/lib/keys/orphans';
import { shortHash } from '@/lib/keys/session';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  resolveEnvironment,
  type Registry,
} from './environments';
import type { Outcome } from './gateway-status';
import { loadKeyHashes } from './keys';

/**
 * Pruning orphaned key metadata (ADR-0009 §7, `lib/keys/orphans.ts`): the
 * rows describing keys that were deleted outside the dashboard. A
 * dashboard-only write, audited per row as `key.metadata.delete` with the row
 * as `before`, so what was pruned stays readable in the audit log.
 *
 * The prune re-reads `GET /g2/keys` itself rather than trusting the page it
 * was reviewed on: a key recreated or restored since stays described, and a
 * failed list prunes nothing.
 */

export const ORPHAN_NOTE =
  'orphan prune: GET /g2/keys no longer lists this hash (deleted outside the dashboard)';

export type KeyOrphanDeps = {
  handle: DataHandle;
  orgId: string;
  /** Every hash the gateway lists; `loadKeyHashes` by default. */
  listKeys?: (environment: string) => Promise<Outcome<string[]>>;
  registry?: Registry;
};

const defaultListKeys = async (environment: string) => (await loadKeyHashes(environment)).hashes;

/** The orphaned rows of `environment` right now, or why none can be named. */
export async function checkKeyOrphans(
  environment: string,
  deps: KeyOrphanDeps,
): Promise<OrphanCheck<KeyMetadata>> {
  const listed = await (deps.listKeys ?? defaultListKeys)(environment);
  if (!listed.ok) return findOrphans(listed, []);
  return findOrphans(listed, await listAllKeyMetadata(deps.handle, deps.orgId, environment));
}

/**
 * Removes the metadata rows named by the form's `hash` fields in its
 * `environment`, for `actor` (who needs `keys:write`; a refusal is audited as
 * `denied`), but only those that are orphans at this moment.
 */
export async function pruneKeyOrphans(
  actor: AuditActor,
  form: FormData,
  deps: KeyOrphanDeps,
): Promise<PruneOrphansState> {
  const environment = form.get('environment');
  const hashes = [
    ...new Set(form.getAll('hash').filter((v): v is string => typeof v === 'string')),
  ];
  if (typeof environment !== 'string') return { error: 'The form is missing its environment.' };
  if (hashes.length === 0) return { error: 'Nothing selected to prune.' };

  if (!can(actor.role, 'keys:write')) {
    const message = `forbidden: the ${actor.role} role lacks the keys:write permission (prune key metadata)`;
    try {
      await recordAudit(deps.handle, deps.orgId, {
        actor,
        action: KEY_METADATA_ACTIONS.delete,
        target: null,
        environment,
        request: { prune: hashes },
        outcome: 'denied',
        error: message,
      });
    } catch (error) {
      console.error(`[audit] FAILED to record denied ${KEY_METADATA_ACTIONS.delete}:`, error);
    }
    return { error: `${message[0].toUpperCase()}${message.slice(1)}.` };
  }

  let environmentId: string;
  try {
    environmentId = resolveEnvironment(environment, deps.registry).id;
  } catch (error) {
    if (error instanceof UnknownEnvironmentError || error instanceof RegistryConfigError) {
      return { error: error.message };
    }
    throw error;
  }

  const check = await checkKeyOrphans(environmentId, deps);
  if (!check.ok) return { error: `Nothing pruned: ${check.error}` };
  const orphaned = new Set(check.orphans.map((row) => row.keyHash));

  const pruned: string[] = [];
  const kept: { hash: string; reason: string }[] = [];
  for (const hash of hashes) {
    if (!orphaned.has(hash)) {
      kept.push({
        hash,
        reason: 'not an orphan now: the gateway lists this key, or it has no metadata row',
      });
      continue;
    }
    try {
      const removed = await deleteKeyMetadata(deps.handle, deps.orgId, {
        environment: environmentId,
        keyHash: hash,
        actor,
        note: ORPHAN_NOTE,
      });
      if (removed === null) kept.push({ hash, reason: 'already gone' });
      else pruned.push(hash);
    } catch (error) {
      console.error(`[inventory] FAILED to prune key metadata ${hash}:`, error);
      kept.push({ hash, reason: 'the dashboard database refused the delete (see the server log)' });
    }
  }
  return {
    error: null,
    notice:
      pruned.length === 0
        ? 'Nothing pruned.'
        : `Pruned ${pruned.length} orphaned row${pruned.length === 1 ? '' : 's'}${pruned.length <= 3 ? ` (${pruned.map(shortHash).join(', ')})` : ''}. Dashboard-only: no gateway change.`,
    pruned,
    kept,
  };
}
