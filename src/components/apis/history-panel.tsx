'use client';

import { DiffTable } from '@/components/diff/diff-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { diffJson } from '@/lib/audit/diff';
import type { JsonValue } from '@/lib/db/schema/shared';

/** One stored version, as the page hands it to the browser. */
export type HistoryEntry = {
  id: string;
  action: 'baseline' | 'create' | 'update' | 'delete';
  definition: JsonValue | null;
  actorEmail: string | null;
  /** ISO 8601. */
  createdAt: string;
};

const ACTION_LABEL: Record<HistoryEntry['action'], string> = {
  baseline: 'before the first dashboard edit',
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/**
 * The definition's versions in this environment, newest first, each with what
 * it changed from the one before (ADR-0008). "Load into the draft" is the
 * rollback: the version becomes the draft, and saving it goes through the same
 * review, save and audit as any edit.
 */
export function HistoryPanel({
  entries,
  canWrite,
  onRestore,
}: {
  entries: readonly HistoryEntry[];
  canWrite: boolean;
  onRestore: (entry: HistoryEntry) => void;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted">
        No versions yet. The first save from the dashboard keeps both the version it replaces and
        the new one.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {entries.map((entry, index) => {
        const previous = entries[index + 1];
        const changes = previous ? diffJson(previous.definition, entry.definition) : [];
        return (
          <li key={entry.id} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <Badge variant={entry.action === 'delete' ? 'destructive' : 'secondary'}>
                  {ACTION_LABEL[entry.action]}
                </Badge>{' '}
                <time dateTime={entry.createdAt} className="text-muted">
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
                {entry.actorEmail && <span className="text-muted"> · {entry.actorEmail}</span>}
                {index === 0 && <span className="ml-1 text-xs text-muted">(latest)</span>}
              </p>
              {canWrite && entry.definition !== null && index > 0 && (
                <Button variant="outline" size="sm" onClick={() => onRestore(entry)}>
                  Load into the draft
                </Button>
              )}
            </div>
            {previous && changes.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted">
                  {changes.length} change{changes.length === 1 ? '' : 's'} from the version before
                </summary>
                <div className="mt-2">
                  <DiffTable changes={changes} />
                </div>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
