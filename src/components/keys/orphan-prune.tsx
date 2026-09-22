'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/users/controls';
import { PRUNE_IDLE, type PruneOrphansState } from '@/lib/keys/orphans';

/** `pruneKeyOrphansAction`, passed in by the page so this module imports nothing server-side. */
export type PruneKeyOrphans = (
  previous: PruneOrphansState,
  formData: FormData,
) => Promise<PruneOrphansState>;

export type OrphanRow = {
  hash: string;
  short: string;
  label: string | null;
  owner: string | null;
  /** ISO time the row was last written. */
  updatedAt: string | null;
};

/**
 * Orphaned key metadata (ADR-0009 §7): rows describing keys the gateway no
 * longer lists, left by deletes made outside the dashboard. Listed on `/keys`
 * for `keys:write`; pruning is reviewed in a dialog, and the server re-checks
 * the gateway's list before removing anything.
 */
export function OrphanPrune({
  orphans,
  environment,
  action,
}: {
  orphans: readonly OrphanRow[];
  environment: { id: string; label: string };
  action: PruneKeyOrphans;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, PRUNE_IDLE);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(orphans.map((row) => row.hash)),
  );
  const shown = orphans.filter((row) => chosen.has(row.hash));

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
      <p>
        <span className="font-medium">
          {orphans.length} metadata row{orphans.length === 1 ? '' : 's'} describe
          {orphans.length === 1 ? 's' : ''} keys the gateway no longer lists
        </span>{' '}
        in {environment.label}: deleted outside the dashboard (the g2way CLI, another tool). The
        labels are only in the dashboard; pruning them changes nothing in the gateway.
      </p>
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Review and prune
        </Button>
      </div>
      {state.error !== null && (
        <p role="alert" className="font-mono text-xs break-all text-danger">
          {state.error}
        </p>
      )}
      <Notice message={state.error === null ? state.notice : undefined} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Prune orphaned key metadata?</DialogTitle>
            <DialogDescription>
              Removes the label, owner and notes of the keys below from the dashboard database. Each
              removal is audited as key.metadata.delete with the old values. Before removing
              anything the server reads GET /g2/keys again: a key the gateway lists by then is kept,
              and if that read fails nothing is pruned.
            </DialogDescription>
          </DialogHeader>
          <form
            action={(form) => {
              setOpen(false);
              formAction(form);
            }}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="environment" value={environment.id} />
            <ul className="max-h-72 overflow-y-auto rounded-md border border-border">
              {orphans.map((row) => (
                <li key={row.hash} className="border-b border-border px-3 py-1.5 last:border-b-0">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      name="hash"
                      value={row.hash}
                      checked={chosen.has(row.hash)}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.hash)) next.delete(row.hash);
                          else next.add(row.hash);
                          return next;
                        })
                      }
                    />
                    <span>
                      <span className="font-medium">{row.label ?? 'no label'}</span>
                      {row.owner !== null && (
                        <span className="text-xs text-muted"> · owner {row.owner}</span>
                      )}
                      <span className="block font-mono text-xs text-muted" title={row.hash}>
                        {row.short}
                        {row.updatedAt !== null && ` · last edited ${row.updatedAt.slice(0, 10)}`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pending || shown.length === 0}>
                {pending ? 'Pruning…' : `Prune ${shown.length}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
