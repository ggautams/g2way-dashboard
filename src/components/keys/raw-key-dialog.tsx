'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** A raw key the gateway just minted, held only while its dialog is open. */
export type MintedKey = { key: string; hash: string };

/**
 * Shows a raw key exactly once. The key lives in the caller's state only while
 * this is open; `onDone` must drop it (the callers set that state to `null`
 * and navigate by hash). It is never logged, stored, or put in a URL, and it
 * cannot be dismissed by a stray click outside or Escape: only by the button.
 */
export function RawKeyDialog({
  minted,
  title,
  children,
  onDone,
}: {
  minted: MintedKey | null;
  title: string;
  /** Extra warnings above the key (a partial rotation). */
  children?: React.ReactNode;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  const copy = async () => {
    if (minted === null) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  const done = () => {
    setCopied(null);
    onDone();
  };

  return (
    <Dialog open={minted !== null}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy the key now. This is the only time it is shown: the gateway stores only its hash,
            and neither the gateway nor this dashboard can show it again.
          </DialogDescription>
        </DialogHeader>
        {children}
        {minted !== null && (
          <div className="flex flex-col gap-2">
            <div className="flex items-stretch gap-2">
              <input
                aria-label="The new API key"
                readOnly
                value={minted.key}
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-border bg-subtle px-3 py-2 font-mono text-sm"
              />
              <Button type="button" variant="outline" onClick={copy}>
                {copied === 'yes' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {copied === 'failed' && (
              <p role="alert" className="text-xs text-danger">
                The browser refused clipboard access: select the key and copy it by hand.
              </p>
            )}
            <p className="text-xs text-muted">
              Key hash (how the dashboard and audit log refer to it):{' '}
              <span className="font-mono break-all">{minted.hash}</span>
            </p>
          </div>
        )}
        <DialogFooter>
          <Button onClick={done}>I have stored the key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
