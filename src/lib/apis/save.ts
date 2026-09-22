/**
 * Writing API definitions from the designer. Every call goes through the BFF
 * (`bffClient`), never to the gateway directly: the BFF holds the secret,
 * checks the role and the request's origin, scopes the body to the configured
 * org, and audits the write with its before/after (ADR-0006). Universal.
 *
 * A write reaches the gateway's storage only: nothing routes differently until
 * `POST /g2/reload` (`docs/g2way-map.md`).
 */

import { diffJson, type DiffEntry } from '@/lib/audit/diff';
import type { JsonValue } from '@/lib/db/schema/shared';
import { unwrap, type G2Client } from '@/lib/g2/client';
import { GatewayError } from '@/lib/g2/errors';
import type { ApiDefinition } from './list';

export type WriteResult = { ok: true } | { ok: false; error: string; status?: number };

/** The changes a save would make, from what is stored (`null`: nothing yet) to the draft. */
export function saveDiff(stored: ApiDefinition | null, draft: ApiDefinition): DiffEntry[] {
  return diffJson(stored as JsonValue | null, draft as JsonValue);
}

/**
 * Why the draft cannot be saved as it is, beyond the form's own checks, or
 * `null`. The stored id names the resource (`PUT /g2/apis/{id}` refuses a body
 * naming another), so an edit may not change it; saving under a new id is a new
 * API.
 */
export function saveBlocker(stored: ApiDefinition | null, draft: ApiDefinition): string | null {
  if (stored !== null && draft.api_id !== stored.api_id) {
    return `The id cannot change (it was ${stored.api_id}). Create a new API to use another id.`;
  }
  return null;
}

async function settleWrite(call: () => Promise<unknown>): Promise<WriteResult> {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    // The BFF answers every failure, the gateway's own included, as {"error"}.
    if (error instanceof GatewayError) {
      return { ok: false, error: error.message, status: error.status };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Creates (`POST /g2/apis`) or replaces (`PUT /g2/apis/{id}`) the definition. */
export function saveApi(
  client: G2Client,
  draft: ApiDefinition,
  creating: boolean,
): Promise<WriteResult> {
  return settleWrite(() =>
    creating
      ? unwrap(client.POST('/g2/apis', { body: draft }))
      : unwrap(
          client.PUT('/g2/apis/{id}', { params: { path: { id: draft.api_id } }, body: draft }),
        ),
  );
}

export function deleteApi(client: G2Client, apiId: string): Promise<WriteResult> {
  return settleWrite(() =>
    unwrap(client.DELETE('/g2/apis/{id}', { params: { path: { id: apiId } } })),
  );
}

/**
 * The definition as stored right now, to diff against before saving: someone
 * may have changed it since the designer loaded it. `null` if it is gone.
 */
export async function fetchStored(
  client: G2Client,
  apiId: string,
): Promise<{ ok: true; stored: ApiDefinition | null } | { ok: false; error: string }> {
  try {
    return {
      ok: true,
      stored: await unwrap(client.GET('/g2/apis/{id}', { params: { path: { id: apiId } } })),
    };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return { ok: true, stored: null };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
