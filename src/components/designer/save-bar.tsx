'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DiffTable } from '@/components/diff/diff-table';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DiffEntry } from '@/lib/audit/diff';
import { RESOURCES, type ResourceKind, type ResourceKinds } from '@/lib/designer/resources';
import { describeFailure, saveDiff } from '@/lib/designer/write';
import { bffClient } from '@/lib/g2/client';

export type DesignerEnvironment = { id: string; label: string };

type Review =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; stored: object | null; changes: DiffEntry[]; drifted: boolean };

/** Every write screen says so: saving is not the same as going live (CLAUDE.md). */
export function NotLiveNote({
  kind,
  environment,
}: {
  kind: ResourceKind;
  environment: DesignerEnvironment;
}) {
  return (
    <p className="text-xs text-muted">
      Saving writes to <span className="font-medium text-foreground">{environment.label}</span>
      &apos;s storage. {RESOURCES[kind].notLive}
    </p>
  );
}

/**
 * Review-and-save for a designer. "Review changes" re-reads the stored
 * resource through the BFF and diffs it against the draft, so the preview
 * shows what the save will really change, including anything someone else
 * changed since the page loaded. Saving goes to the environment the page was
 * loaded from, named explicitly, whatever the switcher says by then.
 */
export function SaveBar<K extends ResourceKind>({
  kind,
  original,
  draft,
  blocker,
  environment,
  id: fixedId,
}: {
  kind: K;
  original: ResourceKinds[K] | null;
  draft: ResourceKinds[K];
  /** The stored resource's id when the draft does not name it (a key's hash). */
  id?: string;
  /** Why the draft cannot be saved yet, or `null`. */
  blocker: string | null;
  environment: DesignerEnvironment;
}) {
  const router = useRouter();
  const resource = RESOURCES[kind];
  const creating = original === null;
  const id = fixedId ?? resource.idOf(draft);
  const [review, setReview] = useState<Review | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = bffClient(environment.id);

  const openReview = async () => {
    setError(null);
    if (creating) {
      setReview({ state: 'ready', stored: null, changes: saveDiff(null, draft), drifted: false });
      return;
    }
    setReview({ state: 'loading' });
    const current = await resource.fetchStored(client, fixedId ?? resource.idOf(original));
    if (!current.ok) return setReview({ state: 'failed', error: current.error });
    setReview({
      state: 'ready',
      stored: current.stored,
      changes: saveDiff(current.stored, draft),
      drifted: current.stored !== null && saveDiff(original, current.stored).length > 0,
    });
  };

  const save = async () => {
    setSaving(true);
    const result = await resource.save(client, draft, creating, id);
    setSaving(false);
    if (!result.ok) return setError(describeFailure(result));
    setReview(null);
    router.replace(`${resource.viewHref(id)}?saved=1`);
    router.refresh();
  };

  return (
    <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
      <div className="flex flex-col gap-0.5">
        {blocker ? (
          <p className="text-xs text-danger">{blocker}</p>
        ) : (
          <NotLiveNote kind={kind} environment={environment} />
        )}
      </div>
      <Button onClick={openReview} disabled={blocker !== null}>
        {creating ? 'Review and create' : 'Review changes'}
      </Button>

      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{creating ? `Create ${id}` : `Save changes to ${id}`}</DialogTitle>
            <DialogDescription>
              In {environment.label}. The gateway validates the {resource.noun} when it is saved.{' '}
              {resource.notLive}
            </DialogDescription>
          </DialogHeader>

          {review?.state === 'loading' && (
            <p className="text-sm text-muted">Reading what is stored…</p>
          )}
          {review?.state === 'failed' && (
            <p role="alert" className="font-mono text-xs text-danger">
              Could not read the stored {resource.noun}: {review.error}
            </p>
          )}
          {review?.state === 'ready' && (
            <div className="flex flex-col gap-3">
              {!creating && review.stored === null && (
                <p className="text-sm text-warning">
                  This {resource.noun} has been deleted since you opened it. Saving will create it
                  again.
                </p>
              )}
              {review.drifted && review.stored !== null && (
                <p className="text-sm text-warning">
                  Someone changed this {resource.noun} since you opened it. The changes below are
                  against what is stored now, so saving also overwrites theirs.
                </p>
              )}
              {review.changes.length === 0 ? (
                <p className="text-sm text-muted">No changes to save.</p>
              ) : (
                <DiffTable changes={review.changes} />
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              The gateway refused the save: {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)}>
              Keep editing
            </Button>
            <Button
              onClick={save}
              disabled={saving || review?.state !== 'ready' || review.changes.length === 0}
            >
              {saving ? 'Saving…' : creating ? 'Create' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Deletes a stored resource after a confirmation naming it. */
export function DeleteButton({
  kind,
  id,
  name,
  environment,
}: {
  kind: ResourceKind;
  id: string;
  name: string;
  environment: DesignerEnvironment;
}) {
  const router = useRouter();
  const resource = RESOURCES[kind];
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    const result = await resource.remove(bffClient(environment.id), id);
    setDeleting(false);
    if (!result.ok) return setError(describeFailure(result));
    router.replace(`${resource.listHref}?deleted=${encodeURIComponent(id)}`);
    router.refresh();
  };

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              Removes the {resource.noun} <span className="font-mono">{id}</span> from{' '}
              {environment.label}&apos;s storage. {resource.notLive}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              The gateway refused the delete: {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
