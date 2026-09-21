import type { Metadata } from 'next';
import Link from 'next/link';
import { OutcomeBadge, formatAuditTime } from '@/components/audit/outcome-badge';
import { AUDIT_PAGE_SIZE, auditQueryString, parseAuditQuery } from '@/lib/audit/query';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listAudit } from '@/lib/db/audit';
import { AUDIT_OUTCOMES } from '@/lib/db/schema/shared';
import { getOrgId } from '@/lib/g2/environments';

export const metadata: Metadata = { title: 'Audit log' };

const INPUT =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent';

/**
 * Who changed what (ADR-0006). Owners and admins only (`audit:read`). A plain
 * GET form filters the list, so it works without JavaScript and every view has
 * a shareable URL.
 */
export default async function AuditPage({ searchParams }: PageProps<'/audit'>) {
  await requirePermission('audit:read');
  const { query, filter, offset, problems } = parseAuditQuery(await searchParams);
  const { entries, hasMore } = await listAudit(getDatabase(), getOrgId(), filter, {
    limit: AUDIT_PAGE_SIZE,
    offset,
  });
  const filtered = Object.keys(filter).length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted">
          Every gateway write made through the dashboard, account change and sign-in, with the state
          before and after. Secrets and raw API keys are never recorded. Times are UTC.
        </p>
      </header>

      <form
        method="get"
        className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3 lg:grid-cols-6"
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          Actor
          <input
            name="actor"
            defaultValue={query.actor}
            placeholder="email contains"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Action
          <input
            name="action"
            defaultValue={query.action}
            placeholder="e.g. api. or user.create"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Target
          <input
            name="target"
            defaultValue={query.target}
            placeholder="contains"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Outcome
          <select name="outcome" defaultValue={query.outcome} className={INPUT}>
            <option value="">any</option>
            {AUDIT_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          From (UTC)
          <input type="date" name="from" defaultValue={query.from} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          To (UTC, inclusive)
          <input type="date" name="to" defaultValue={query.to} className={INPUT} />
        </label>
        <div className="flex items-center gap-3 sm:col-span-3 lg:col-span-6">
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            Filter
          </button>
          {filtered && (
            <Link href="/audit" className="text-sm text-muted underline">
              Clear
            </Link>
          )}
          {problems.length > 0 && (
            <p role="alert" className="text-xs text-danger">
              Ignored: {problems.join('; ')}.
            </p>
          )}
        </div>
      </form>

      {entries.length === 0 ? (
        <p className="text-sm text-muted">
          {filtered || query.page > 1 ? 'No entries match.' : 'Nothing has been recorded yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">Gateway call</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    <Link href={`/audit/${entry.id}`} className="text-accent underline">
                      {formatAuditTime(entry.createdAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {entry.actorEmail ?? <span className="text-muted">nobody signed in</span>}
                    {entry.actorRole && (
                      <span className="ml-1 font-mono text-xs text-muted">({entry.actorRole})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
                  <td
                    className="max-w-48 truncate px-3 py-2 font-mono text-xs"
                    title={entry.target ?? undefined}
                  >
                    {entry.target ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <OutcomeBadge outcome={entry.outcome} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {entry.gatewayMethod ? (
                      <>
                        {entry.gatewayMethod} {entry.gatewayPath}
                        {entry.gatewayStatus !== null && ` → ${entry.gatewayStatus}`}
                        {entry.environment && (
                          <span className="text-muted"> ({entry.environment})</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(query.page > 1 || hasMore) && (
        <nav aria-label="Pages" className="flex items-center gap-4 text-sm">
          {query.page > 1 && (
            <Link
              href={`/audit${auditQueryString(query, query.page - 1)}`}
              className="text-accent underline"
            >
              Newer
            </Link>
          )}
          <span className="text-muted">Page {query.page}</span>
          {hasMore && (
            <Link
              href={`/audit${auditQueryString(query, query.page + 1)}`}
              className="text-accent underline"
            >
              Older
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
