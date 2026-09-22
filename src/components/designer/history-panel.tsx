'use client';

import { useMemo } from 'react';
import { DiffTable } from '@/components/diff/diff-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ACTION_LABEL, historyRows, type HistoryEntry } from '@/lib/designer/history';

/**
 * A resource's versions in this environment, newest first, each with what it
 * changed from the one before (ADR-0008). "Load into the draft" is the
 * rollback: the version becomes the draft, and saving it goes through the same
 * review, save, audit and reload as any edit. Nothing here writes.
 */
export function HistoryPanel<T>({
  entries,
  canWrite,
  isShape,
  onRestore,
}: {
  entries: readonly HistoryEntry[];
  /** Whether the role may write this resource; read-only roles only look. */
  canWrite: boolean;
  /** Whether a stored body is a draft the designer can edit. */
  isShape: (value: unknown) => value is T;
  onRestore: (draft: T, entry: HistoryEntry) => void;
}) {
  const rows = useMemo(() => historyRows(entries, canWrite, isShape), [entries, canWrite, isShape]);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No versions yet. The first save from the dashboard keeps both the version it replaces and
        the new one.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {rows.map(({ entry, latest, hasPrevious, changes, restorable }) => (
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
              {latest && <span className="ml-1 text-xs text-muted">(latest)</span>}
            </p>
            {restorable !== null && (
              <Button variant="outline" size="sm" onClick={() => onRestore(restorable, entry)}>
                Load into the draft
              </Button>
            )}
          </div>
          {hasPrevious && changes.length > 0 && (
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
      ))}
    </ol>
  );
}

/** Shown on the form after a version was loaded: the rollback is not saved yet. */
export function RestoredNote({ from }: { from: string }) {
  return (
    <p role="status" className="mt-3 text-sm text-warning">
      Loaded the version from {from} into the draft. Review and save it to roll back.
    </p>
  );
}
