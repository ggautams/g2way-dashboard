'use client';

import { useSyncExternalStore } from 'react';
import { toasts, type Toast } from '@/lib/toast';
import { CloseIcon } from './icons';

const NONE: readonly Toast[] = [];

const ACCENT: Record<Toast['kind'], string> = {
  success: 'border-l-success',
  error: 'border-l-danger',
  info: 'border-l-accent',
};

/** Renders the app-wide toast store. Raise toasts with `toast` from `@/lib/toast`. */
export function Toaster() {
  const items = useSyncExternalStore(toasts.subscribe, toasts.getSnapshot, () => NONE);
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 sm:left-auto sm:w-96"
    >
      <ol aria-live="polite" className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            role={item.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex gap-3 rounded-md border border-l-4 border-border bg-surface p-3 text-sm shadow-lg ${ACCENT[item.kind]}`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 break-words font-mono text-xs text-muted">
                  {item.description}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => toasts.dismiss(item.id)}
              className="self-start rounded p-0.5 text-muted hover:text-foreground"
            >
              <CloseIcon />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
