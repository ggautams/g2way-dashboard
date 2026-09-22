/**
 * The designer History tab's model (ADR-0008), shared by every versioned
 * resource (API definitions and policies). Universal: the panel renders it in
 * the browser, and `load-history.ts` builds the entries on the server.
 */

import { diffJson, type DiffEntry } from '@/lib/audit/diff';
import type { JsonValue, VersionAction } from '@/lib/db/schema/shared';

/** One stored version, as the page hands it to the browser. */
export type HistoryEntry = {
  id: string;
  action: VersionAction;
  definition: JsonValue | null;
  actorEmail: string | null;
  /** ISO 8601. */
  createdAt: string;
};

export const ACTION_LABEL: Record<VersionAction, string> = {
  baseline: 'before the first dashboard edit',
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/** One History tab row: the entry, what it changed, and whether it can be loaded. */
export type HistoryRow<T> = {
  entry: HistoryEntry;
  latest: boolean;
  /** Whether a version before it is listed, so `changes` means something. */
  hasPrevious: boolean;
  /** What it changed from the version before it (empty for the oldest listed). */
  changes: DiffEntry[];
  /**
   * The version as a draft, when this viewer may load it into the draft: a
   * role that can write, not the latest version (that is the draft already),
   * not a delete, and a body the designer can edit. `null` otherwise.
   */
  restorable: T | null;
};

/**
 * Rows for `entries` (newest first). Rollback is "load into the draft"
 * (ADR-0008 §5): nothing here writes, and read-only roles get no restorable row.
 */
export function historyRows<T>(
  entries: readonly HistoryEntry[],
  canWrite: boolean,
  isShape: (value: unknown) => value is T,
): HistoryRow<T>[] {
  return entries.map((entry, index) => {
    const previous = entries[index + 1];
    const latest = index === 0;
    const definition = entry.definition;
    return {
      entry,
      latest,
      hasPrevious: previous !== undefined,
      changes: previous ? diffJson(previous.definition, definition) : [],
      restorable: canWrite && !latest && isShape(definition) ? definition : null,
    };
  });
}
