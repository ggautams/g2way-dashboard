import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { OutcomeBadge, formatAuditTime } from '@/components/audit/outcome-badge';
import { diffJson, type DiffEntry } from '@/lib/audit/diff';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getAuditEntry } from '@/lib/db/audit';
import type { JsonValue } from '@/lib/db/schema/shared';
import { getOrgId } from '@/lib/g2/environments';

export const metadata: Metadata = { title: 'Audit entry' };

const KIND_STYLE: Record<DiffEntry['kind'], string> = {
  added: 'text-success',
  removed: 'text-danger',
  changed: 'text-warning',
};

/** One audit entry: who, what, the gateway call, and the before/after diff (ADR-0006). */
export default async function AuditEntryPage({ params }: PageProps<'/audit/[id]'>) {
  await requirePermission('audit:read');
  const { id } = await params;
  const entry = await getAuditEntry(getDatabase(), getOrgId(), id);
  if (entry === undefined) notFound();

  const changes = diffJson(entry.before, entry.after);
  const hasSnapshots = entry.before !== null || entry.after !== null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/audit" className="text-sm text-muted underline">
          ← Audit log
        </Link>
        <h1 className="flex flex-wrap items-baseline gap-3 text-2xl font-semibold tracking-tight">
          <span className="font-mono">{entry.action}</span>
          <OutcomeBadge outcome={entry.outcome} />
        </h1>
      </header>

      <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-[10rem_1fr]">
        <Field label="When">{formatAuditTime(entry.createdAt)}</Field>
        <Field label="Actor">
          {entry.actorEmail ?? <span className="text-muted">nobody signed in</span>}
          {entry.actorRole && (
            <span className="ml-1 font-mono text-xs text-muted">({entry.actorRole})</span>
          )}
        </Field>
        <Field label="Target">
          <span className="break-all font-mono text-xs">{entry.target ?? '—'}</span>
        </Field>
        <Field label="Gateway call">
          {entry.gatewayMethod ? (
            <span className="break-all font-mono text-xs">
              {entry.gatewayMethod} {entry.gatewayPath}
              {entry.gatewayStatus !== null ? ` → ${entry.gatewayStatus}` : ' → no response'}
              {entry.environment && (
                <span className="text-muted"> (environment {entry.environment})</span>
              )}
            </span>
          ) : (
            <span className="text-muted">none</span>
          )}
        </Field>
        {entry.error && (
          <Field label="Error">
            <span className="font-mono text-xs text-danger">{entry.error}</span>
          </Field>
        )}
        {entry.note && (
          <Field label="Note">
            <span className="text-xs text-muted">{entry.note}</span>
          </Field>
        )}
        {entry.outcome === 'pending' && (
          <Field label="Pending">
            <span className="text-xs text-warning">
              The write was sent (or about to be) but its result was never recorded — check the
              gateway for its actual state.
            </span>
          </Field>
        )}
      </dl>

      <section aria-labelledby="changes" className="flex flex-col gap-3">
        <h2 id="changes" className="text-lg font-medium">
          Changes
        </h2>
        {!hasSnapshots ? (
          <p className="text-sm text-muted">
            No before or after state was recorded for this entry.
          </p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted">Before and after are identical.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">Change</th>
                  <th className="px-3 py-2 font-medium">Before</th>
                  <th className="px-3 py-2 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr
                    key={`${change.kind}:${change.path}`}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {change.path || '(whole document)'}
                    </td>
                    <td className={`px-3 py-2 font-mono text-xs ${KIND_STYLE[change.kind]}`}>
                      {change.kind}
                    </td>
                    <td className="px-3 py-2">
                      {'before' in change && <Json value={change.before} />}
                    </td>
                    <td className="px-3 py-2">
                      {'after' in change && <Json value={change.after} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="snapshots" className="flex flex-col gap-3">
        <h2 id="snapshots" className="text-lg font-medium">
          Snapshots
        </h2>
        <Snapshot label="Before" value={entry.before} />
        <Snapshot label="After" value={entry.after} />
        <Snapshot label="Request" value={entry.request} />
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Json({ value }: { value: JsonValue }) {
  return (
    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Snapshot({ label, value }: { label: string; value: JsonValue | null }) {
  if (value === null) {
    return (
      <p className="text-sm text-muted">
        {label}: <span className="font-mono text-xs">none</span>
      </p>
    );
  }
  return (
    <details className="rounded-lg border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium">{label}</summary>
      <pre className="overflow-x-auto border-t border-border p-4 font-mono text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
