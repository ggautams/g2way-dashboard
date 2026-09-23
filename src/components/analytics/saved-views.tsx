import Link from 'next/link';
import type { ViewSummary } from '@/lib/analytics/saved-views';
import { DeleteViewButton, SaveViewForm, type SavedViewAction } from './saved-view-forms';

/** One saved view as listed: where it opens, what it shows, whether this user may delete it. */
export type SavedViewItem = {
  id: string;
  name: string;
  href: string;
  summary: ViewSummary;
  shared: boolean;
  /** The creator's email, shown on shared views. */
  owner: string;
  deletable: boolean;
  /** This view is the one on screen. */
  current: boolean;
};

/**
 * Saved views on `/analytics` (ADR-0016): the environment's shared views,
 * then the user's own, each a plain link; below, a form that saves the view
 * on screen. A Server Component; only the two forms run in the browser.
 */
export function SavedViewsPanel({
  items,
  environment,
  query,
  canShare,
  saveAction,
  deleteAction,
}: {
  items: SavedViewItem[];
  environment: string;
  query: string;
  canShare: boolean;
  saveAction: SavedViewAction;
  deleteAction: SavedViewAction;
}) {
  const shared = items.filter((item) => item.shared);
  const mine = items.filter((item) => !item.shared);
  return (
    <details open={items.length > 0} className="rounded-lg border border-border bg-surface text-sm">
      <summary className="cursor-pointer px-4 py-2 font-medium">
        Saved views ({items.length})
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-4 py-3">
        {items.length === 0 ? (
          <p className="text-muted">
            No saved views in this environment yet. A view keeps the source, the range and the
            selection: a fixed range such as the last 24 hours moves with time; a custom range
            always shows the same window.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <ViewList
              title="Shared"
              items={shared}
              environment={environment}
              deleteAction={deleteAction}
            />
            <ViewList
              title="Yours"
              items={mine}
              environment={environment}
              deleteAction={deleteAction}
            />
          </div>
        )}
        <SaveViewForm
          action={saveAction}
          environment={environment}
          query={query}
          canShare={canShare}
        />
        <p className="text-xs text-muted">
          Kept in the dashboard database for this environment; no gateway change.{' '}
          {canShare
            ? 'Shared views are listed for everyone who can open this page.'
            : 'Your views are listed for you only.'}
        </p>
      </div>
    </details>
  );
}

function ViewList({
  title,
  items,
  environment,
  deleteAction,
}: {
  title: string;
  items: SavedViewItem[];
  environment: string;
  deleteAction: SavedViewAction;
}) {
  return (
    <section aria-label={`${title} saved views`} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">None.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
              <Link
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                className={item.current ? 'font-semibold underline' : 'underline'}
              >
                {item.name}
              </Link>
              <span className="text-xs text-muted">
                {item.summary.range}
                {item.summary.absolute ? ' (fixed window)' : ''}
                {item.summary.source === 'prometheus' ? ' · Prometheus' : ''}
                {item.summary.selection.length > 0 ? ` · ${item.summary.selection.join(', ')}` : ''}
                {item.shared ? ` · by ${item.owner}` : ''}
              </span>
              {item.deletable && (
                <DeleteViewButton
                  action={deleteAction}
                  environment={environment}
                  id={item.id}
                  name={item.name}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
