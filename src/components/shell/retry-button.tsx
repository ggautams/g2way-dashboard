'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Re-renders the page's Server Components, re-probing the gateway. */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-xs hover:bg-subtle disabled:opacity-50"
    >
      {pending ? 'Retrying…' : 'Retry'}
    </button>
  );
}
