'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DesignerEnvironment } from '@/components/designer/save-bar';
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
import { describeFailure, saveDiff } from '@/lib/designer/write';
import { bffClient } from '@/lib/g2/client';
import { fetchStoredKey, rotateKey, saveKey, withActive } from '@/lib/keys/save';
import type { KeySession } from '@/lib/keys/session';
import { RawKeyDialog, type MintedKey } from './raw-key-dialog';

type Review =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; next: KeySession; changes: DiffEntry[] };

/**
 * The soft revoke and its undo: `active` flipped on the session as stored now
 * (re-read, so nobody else's change is overwritten unseen), previewed as a diff.
 */
export function RevokeButton({
  hash,
  active,
  environment,
}: {
  hash: string;
  /** Whether the key is active as the page loaded it. */
  active: boolean;
  environment: DesignerEnvironment;
}) {
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = bffClient(environment.id);
  const verb = active ? 'Revoke' : 'Reactivate';

  const openReview = async () => {
    setError(null);
    setReview({ state: 'loading' });
    const stored = await fetchStoredKey(client, hash);
    if (!stored.ok) return setReview({ state: 'failed', error: stored.error });
    if (stored.stored === null) return setReview({ state: 'failed', error: 'the key is gone' });
    const next = withActive(stored.stored, !active);
    setReview({ state: 'ready', next, changes: saveDiff(stored.stored, next) });
  };

  const save = async () => {
    if (review?.state !== 'ready') return;
    setSaving(true);
    const result = await saveKey(client, hash, review.next);
    setSaving(false);
    if (!result.ok) return setError(describeFailure(result));
    setReview(null);
    router.replace(`/keys/view/${encodeURIComponent(hash)}?saved=1`);
    router.refresh();
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openReview}>
        {verb}
      </Button>
      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{verb} this key?</DialogTitle>
            <DialogDescription>
              {active
                ? 'A soft revoke: the key stays stored but fails auth, from the next request on. Reactivate it any time.'
                : 'The key authenticates again from the next request on.'}{' '}
              In {environment.label}; no reload needed.
            </DialogDescription>
          </DialogHeader>
          {review?.state === 'loading' && (
            <p className="text-sm text-muted">Reading what is stored…</p>
          )}
          {review?.state === 'failed' && (
            <p role="alert" className="font-mono text-xs text-danger">
              Could not read the stored key: {review.error}
            </p>
          )}
          {review?.state === 'ready' &&
            (review.changes.length === 0 ? (
              <p className="text-sm text-muted">Already {active ? 'revoked' : 'active'}.</p>
            ) : (
              <DiffTable changes={review.changes} />
            ))}
          {error && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              The gateway refused the save: {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button
              variant={active ? 'destructive' : 'default'}
              onClick={save}
              disabled={saving || review?.state !== 'ready' || review.changes.length === 0}
            >
              {saving ? 'Saving…' : verb}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Rotation (ADR-0009): a new key with the same session, then the old one
 * deleted, orchestrated and audited by the BFF. The new raw key is shown once.
 */
export function RotateButton({
  hash,
  environment,
}: {
  hash: string;
  environment: DesignerEnvironment;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [leftover, setLeftover] = useState<string | null>(null);

  const rotate = async () => {
    setRotating(true);
    setError(null);
    const result = await rotateKey(environment.id, hash);
    setRotating(false);
    if (!result.ok) return setError(describeFailure(result));
    setConfirming(false);
    setLeftover(result.outcome === 'partial' ? result.error : null);
    setMinted({ key: result.key, hash: result.key_hash });
  };

  const done = () => {
    const next = minted?.hash;
    const partial = leftover !== null;
    setMinted(null);
    setLeftover(null);
    if (next === undefined) return;
    const query = partial ? `rotated=partial&old=${encodeURIComponent(hash)}` : 'rotated=1';
    router.replace(`/keys/view/${encodeURIComponent(next)}?${query}`);
    router.refresh();
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Rotate
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate this key?</DialogTitle>
            <DialogDescription>
              Creates a new key in {environment.label} with this key&apos;s session, deletes this
              key, then shows you the new key once. Clients still using this key fail from that
              moment on. g2way has no atomic rotate: if the delete fails, both keys keep working and
              you are told so.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              Rotation failed; the old key is unchanged: {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={rotate} disabled={rotating}>
              {rotating ? 'Rotating…' : 'Rotate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RawKeyDialog
        minted={minted}
        title={leftover === null ? 'Key rotated' : 'New key created; the old key still works'}
        onDone={done}
      >
        {leftover !== null && minted !== null && (
          <p role="alert" className="text-sm text-danger">
            Both keys now exist. The new key is <span className="font-mono">{minted.hash}</span>,
            but deleting the old key <span className="font-mono break-all">{hash}</span> failed:{' '}
            <span className="font-mono">{leftover}</span>. Delete the old key by hand once clients
            have moved.
          </p>
        )}
      </RawKeyDialog>
    </>
  );
}
