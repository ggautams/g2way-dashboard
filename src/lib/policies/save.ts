/**
 * Writing policies from the designer, through the BFF (`bffClient`) like every
 * gateway write: it holds the secret, checks the role and origin, scopes the
 * body to the configured org and audits the write (ADR-0006). Universal.
 *
 * A write reaches the gateway's storage only: keys resolve the new policy
 * after `POST /g2/reload` (`docs/g2way-map.md`).
 */

import { unwrap, type G2Client } from '@/lib/g2/client';
import {
  settleStored,
  settleWrite,
  type StoredResult,
  type WriteResult,
} from '@/lib/designer/write';
import type { Policy } from './list';

/** Creates (`POST /g2/policies`) or replaces (`PUT /g2/policies/{id}`) the policy. */
export function savePolicy(
  client: G2Client,
  draft: Policy,
  creating: boolean,
): Promise<WriteResult> {
  return settleWrite(() =>
    creating
      ? unwrap(client.POST('/g2/policies', { body: draft }))
      : unwrap(
          client.PUT('/g2/policies/{id}', {
            params: { path: { id: draft.policy_id } },
            body: draft,
          }),
        ),
  );
}

export function deletePolicy(client: G2Client, policyId: string): Promise<WriteResult> {
  return settleWrite(() =>
    unwrap(client.DELETE('/g2/policies/{id}', { params: { path: { id: policyId } } })),
  );
}

/** The policy as stored right now, to diff against before saving; `null` if it is gone. */
export function fetchStoredPolicy(
  client: G2Client,
  policyId: string,
): Promise<StoredResult<Policy>> {
  return settleStored(() =>
    unwrap(client.GET('/g2/policies/{id}', { params: { path: { id: policyId } } })),
  );
}

/**
 * Why the draft cannot be saved beyond the form's checks, or `null`. `PUT
 * /g2/policies/{id}` refuses a body naming another id, and keys reference the
 * id in `apply_policies`, so an edit may not change it.
 */
export function policySaveBlocker(stored: Policy | null, draft: Policy): string | null {
  if (stored !== null && draft.policy_id !== stored.policy_id) {
    return `The id cannot change (it was ${stored.policy_id}): keys reference it. Create a new policy to use another id.`;
  }
  return null;
}
