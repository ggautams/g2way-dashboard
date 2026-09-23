import Link from 'next/link';
import type { GroupDisplay } from '@/lib/analytics/drill';

/** One part of the selection: what it narrows to, and the href without it. */
export type DrillChip = GroupDisplay & {
  dimension: string;
  removeHref: string;
  page: { href: string; label: string } | null;
};

/**
 * What the page's traffic is narrowed to: every API, or one API and at most
 * one value of one other dimension, each removable. Ignored URL parameters
 * are listed with the reason, never dropped silently. A Server Component.
 */
export function DrillBar({
  chips,
  notes,
  clearHref,
}: {
  chips: DrillChip[];
  notes: readonly string[];
  clearHref: string;
}) {
  return (
    <section aria-label="Selection" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Showing</span>
        {chips.length === 0 ? (
          <span className="font-medium">every API and key</span>
        ) : (
          <>
            {chips.map((chip) => (
              <span
                key={chip.dimension}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface py-0.5 pr-1 pl-2"
              >
                <span className="text-xs text-muted">{chip.dimension}</span>
                <span className={chip.mono ? 'font-mono text-xs break-all' : 'font-medium'}>
                  {chip.label}
                </span>
                {chip.detail !== null && (
                  <span className="font-mono text-xs text-muted">{chip.detail}</span>
                )}
                {chip.page !== null && (
                  <Link href={chip.page.href} className="text-xs text-muted hover:underline">
                    {chip.page.label}
                  </Link>
                )}
                <Link
                  href={chip.removeHref}
                  aria-label={`Remove ${chip.dimension} ${chip.label}`}
                  className="rounded px-1 text-muted hover:bg-subtle hover:text-foreground"
                >
                  ×
                </Link>
              </span>
            ))}
            <Link href={clearHref} className="text-xs text-muted hover:underline">
              Clear
            </Link>
          </>
        )}
      </div>
      {notes.length > 0 && (
        <ul role="status" className="list-disc pl-5 text-xs text-warning">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
