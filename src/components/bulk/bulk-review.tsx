'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { BulkCallResult, BulkHalt, BulkItemResult } from '@/lib/bulk/ops';

export type BulkItem = { id: string; label: string; detail?: string };

type Phase =
  | { state: 'review' }
  | { state: 'running' }
  | { state: 'failed'; error: string }
  | { state: 'done'; results: BulkItemResult[]; halted?: BulkHalt };

/**
 * The review-then-report dialog every bulk action goes through: it lists the
 * items the action will touch before anything is sent, then one line per item
 * with what the gateway said. Closing after a run calls `onFinished`.
 */
export function BulkReview({
  title,
  description,
  items,
  confirmLabel,
  destructive = false,
  run,
  onClose,
  onFinished,
}: {
  title: string;
  description: React.ReactNode;
  items: readonly BulkItem[];
  confirmLabel: string;
  destructive?: boolean;
  run: () => Promise<BulkCallResult>;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ state: 'review' });
  const byId = new Map(items.map((item) => [item.id, item]));

  const start = async () => {
    setPhase({ state: 'running' });
    const result = await run();
    if (!result.ok) {
      setPhase({
        state: 'failed',
        error:
          result.status === undefined ? result.error : `${result.error} (HTTP ${result.status})`,
      });
      return;
    }
    setPhase({ state: 'done', results: result.results, halted: result.halted });
  };

  const close = () => {
    if (phase.state === 'running') return;
    if (phase.state === 'done') onFinished();
    onClose();
  };

  const tally =
    phase.state === 'done'
      ? {
          done: phase.results.filter((r) => r.outcome === 'done').length,
          unchanged: phase.results.filter((r) => r.outcome === 'unchanged').length,
          failed: phase.results.filter((r) => r.outcome === 'failed').length,
        }
      : null;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1">{description}</div>
          </DialogDescription>
        </DialogHeader>

        {phase.state !== 'done' && (
          <ul className="max-h-72 overflow-y-auto rounded-md border border-border text-sm">
            {items.map((item) => (
              <li key={item.id} className="border-b border-border px-3 py-1.5 last:border-b-0">
                <span className="font-medium">{item.label}</span>
                {item.detail && <span className="ml-2 text-xs text-muted">{item.detail}</span>}
              </li>
            ))}
          </ul>
        )}

        {phase.state === 'failed' && (
          <p role="alert" className="font-mono text-xs break-all text-danger">
            Nothing was run: {phase.error}
          </p>
        )}

        {phase.state === 'done' && tally !== null && (
          <>
            <p className="text-sm" aria-live="polite">
              {tally.done} done · {tally.unchanged} unchanged ·{' '}
              <span className={tally.failed > 0 ? 'text-danger' : undefined}>
                {tally.failed} failed
              </span>
            </p>
            <ul className="max-h-72 overflow-y-auto rounded-md border border-border text-sm">
              {phase.results.map((result) => (
                <li key={result.id} className="border-b border-border px-3 py-1.5 last:border-b-0">
                  <span className="font-medium">{byId.get(result.id)?.label ?? result.id}</span>{' '}
                  {result.outcome === 'done' && (
                    <Badge variant="outline" className="border-success/40 text-success">
                      done
                    </Badge>
                  )}
                  {result.outcome === 'unchanged' && (
                    <>
                      <Badge variant="secondary">unchanged</Badge>{' '}
                      <span className="text-xs text-muted">{result.reason}</span>
                    </>
                  )}
                  {result.outcome === 'failed' && (
                    <>
                      <Badge variant="outline" className="border-danger/40 text-danger">
                        failed
                      </Badge>{' '}
                      <span className="font-mono text-xs break-all text-danger">
                        {result.error}
                        {result.status !== undefined && ` (HTTP ${result.status})`}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {phase.halted !== undefined && (
              <p role="alert" className="font-mono text-xs break-all text-danger">
                Stopped: {phase.halted.notSent.length} item
                {phase.halted.notSent.length === 1 ? ' was' : 's were'} never sent, because the next
                request was refused: {phase.halted.error}
                {phase.halted.status !== undefined && ` (HTTP ${phase.halted.status})`}
              </p>
            )}
          </>
        )}

        <DialogFooter>
          {phase.state === 'done' ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={phase.state === 'running'}>
                Cancel
              </Button>
              <Button
                variant={destructive ? 'destructive' : 'default'}
                onClick={start}
                disabled={phase.state === 'running' || items.length === 0}
              >
                {phase.state === 'running' ? 'Running…' : confirmLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Selection state for a table: a set of ids, with select-all over the rows shown. */
export function useSelection(ids: readonly string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const shown = selected.size === 0 ? selected : new Set(ids.filter((id) => selected.has(id)));
  return {
    selected: shown,
    toggle(id: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll() {
      setSelected(shown.size === ids.length ? new Set() : new Set(ids));
    },
    clear() {
      setSelected(new Set());
    },
  };
}
