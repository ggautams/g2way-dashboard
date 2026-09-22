import 'server-only';

import { can } from '@/lib/auth/rbac';
import { recordAudit, type AuditActor } from '@/lib/db/audit';
import { KEY_METADATA_ACTIONS, upsertKeyMetadata } from '@/lib/db/key-metadata';
import type { DataHandle } from '@/lib/db/users';
import type { KeyMetadataFields, KeyMetadataFormState } from '@/lib/keys/metadata';
import { parseKeyMetadataForm } from '@/lib/keys/metadata';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  resolveEnvironment,
  type Registry,
} from './environments';
import type { Outcome } from './gateway-status';
import { loadKey } from './keys';

/**
 * Saving a key's dashboard metadata (ADR-0009 §7) from a submitted form: the
 * create flow, just after the gateway answered, and the key view's editor.
 * A dashboard-only write: nothing is sent to the gateway but one read, which
 * confirms the hash names a key in that environment, so the inventory never
 * describes a key that does not exist. No reload, never staged.
 */

export type SaveKeyMetadataDeps = {
  handle: DataHandle;
  orgId: string;
  /** Reads the key by hash; `loadKey` by default. */
  readKey?: (environment: string, hash: string) => Promise<Outcome<unknown>>;
  registry?: Registry;
};

/**
 * Saves the `label`/`owner`/`notes` of key `hash` in `environment` (all three
 * form fields) for `actor`, who needs `keys:write`; a refusal is audited as
 * `denied`. Answers form state: the gateway's own message when the key cannot
 * be read.
 */
export async function saveKeyMetadata(
  actor: AuditActor,
  form: FormData,
  deps: SaveKeyMetadataDeps,
): Promise<KeyMetadataFormState> {
  const environment = form.get('environment');
  const hash = form.get('hash');
  if (typeof environment !== 'string' || typeof hash !== 'string') {
    return { error: 'The form is missing the key or its environment.' };
  }
  if (hash === '' || /[/?#]/.test(hash)) return { error: `Not a key hash: ${hash}` };

  if (!can(actor.role, 'keys:write')) {
    const message = `forbidden: the ${actor.role} role lacks the keys:write permission (key metadata)`;
    try {
      await recordAudit(deps.handle, deps.orgId, {
        actor,
        action: KEY_METADATA_ACTIONS.update,
        target: hash,
        environment,
        outcome: 'denied',
        error: message,
      });
    } catch (error) {
      console.error(`[audit] FAILED to record denied ${KEY_METADATA_ACTIONS.update}:`, error);
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

  const parsed = parseKeyMetadataForm(form);
  if (!parsed.ok) return { error: `Not saved: ${parsed.error}.` };

  const readKey =
    deps.readKey ??
    (async (env: string, key: string) => (await loadKey(env, key, 'viewer')).session);
  const read = await readKey(environmentId, hash);
  if (!read.ok) {
    return {
      error: `Not saved: GET /g2/keys/${hash} failed: ${read.error}${read.status === undefined ? '' : ` (HTTP ${read.status})`}`,
    };
  }

  let saved: KeyMetadataFields;
  try {
    const { after } = await upsertKeyMetadata(deps.handle, deps.orgId, {
      environment: environmentId,
      keyHash: hash,
      fields: parsed.value,
      actor,
    });
    saved = { label: after.label, owner: after.owner, notes: after.notes };
  } catch (error) {
    console.error(`[audit] FAILED to save key metadata for ${hash}:`, error);
    return { error: 'Not saved: the dashboard database refused the write (see the server log).' };
  }
  return { error: null, notice: 'Saved. Dashboard-only: no gateway change, no reload.', saved };
}
