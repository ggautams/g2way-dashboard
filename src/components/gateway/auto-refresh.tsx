'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Re-renders the surrounding Server Component every `intervalMs` so the page
 * stays live, without the browser ever calling the gateway itself. Pauses while
 * the tab is hidden, and can be paused by hand.
 */
export function AutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const tick = () => {
      if (document.visibilityState === 'visible') startTransition(() => router.refresh());
    };
    const timer = window.setInterval(tick, intervalMs);
    // Catch up as soon as a hidden tab comes back, rather than showing stale data.
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [paused, intervalMs, router]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted" aria-live="polite">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${paused ? 'bg-muted' : 'bg-success'} ${pending ? 'animate-pulse' : ''}`}
        />
        {paused ? 'Paused' : `Live · every ${Math.round(intervalMs / 1000)}s`}
      </span>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        className="rounded-md border border-border px-2 py-1 hover:bg-subtle"
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button
        type="button"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        className="rounded-md border border-border px-2 py-1 hover:bg-subtle disabled:opacity-50"
      >
        Refresh
      </button>
    </div>
  );
}
