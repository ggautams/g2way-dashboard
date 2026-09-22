/**
 * What every designer's writes share: settling a BFF call into a result that
 * carries the gateway's own `{"error"}` message, reading back what is stored,
 * and the diff a save would make. Universal: client designers and the tests
 * use it; the calls themselves always go through the BFF (`bffClient`).
 */

import { diffJson, type DiffEntry } from '@/lib/audit/diff';
import type { JsonValue } from '@/lib/db/schema/shared';
import { GatewayError } from '@/lib/g2/errors';

export type WriteResult = { ok: true } | { ok: false; error: string; status?: number };

export type StoredResult<T> = { ok: true; stored: T | null } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a write; a failure keeps the gateway's message verbatim, with its status. */
export async function settleWrite(call: () => Promise<unknown>): Promise<WriteResult> {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    // The BFF answers every failure, the gateway's own included, as {"error"}.
    if (error instanceof GatewayError) {
      return { ok: false, error: error.message, status: error.status };
    }
    return { ok: false, error: message(error) };
  }
}

/** Reads what is stored right now; a 404 is `stored: null` (it is gone). */
export async function settleStored<T>(read: () => Promise<T>): Promise<StoredResult<T>> {
  try {
    return { ok: true, stored: await read() };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return { ok: true, stored: null };
    return { ok: false, error: message(error) };
  }
}

/** The changes a save would make, from what is stored (`null`: nothing yet) to the draft. */
export function saveDiff(stored: object | null, draft: object): DiffEntry[] {
  return diffJson(stored as JsonValue | null, draft as JsonValue);
}

/** A failed write as one line: the gateway's message, and its HTTP status when there is one. */
export function describeFailure(result: { error: string; status?: number }): string {
  return result.status === undefined ? result.error : `${result.error} (HTTP ${result.status})`;
}
