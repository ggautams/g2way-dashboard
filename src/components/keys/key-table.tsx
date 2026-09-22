'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BulkReview, useSelection, type BulkItem } from '@/components/bulk/bulk-review';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { describeBulkOp, runBulk, type KeyBulkOp } from '@/lib/bulk/ops';
import type { KeyListRow } from '@/lib/keys/list-row';

type PolicyChoice = { id: string; name: string; active: boolean };

const CONTROL =
  'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The `/keys` table. With `keys:write` (`bulk` set) rows can be selected and
 * revoked, reactivated, deleted, or given or relieved of one policy in bulk:
 * reviewed first, then one audited gateway call per key, reported per key.
 */
export function KeyTable({
  rows,
  bulk,
}: {
  rows: readonly KeyListRow[];
  bulk?: {
    environment: { id: string; label: string };
    policies: { ok: true; value: PolicyChoice[] } | { ok: false; error: string };
  };
}) {
  const router = useRouter();
  const selection = useSelection(rows.map((row) => row.hash));
  const [policy, setPolicy] = useState('');
  const [op, setOp] = useState<KeyBulkOp | null>(null);
  const chosen = rows.filter((row) => selection.selected.has(row.hash));

  const items: BulkItem[] = chosen.map((row) => ({
    id: row.hash,
    label: row.title ?? row.short,
    detail: [
      row.title !== null ? row.short : null,
      row.state,
      row.policy === null ? null : `policy ${row.policy}`,
    ]
      .filter((part) => part !== null)
      .join(' · '),
  }));

  const needsPolicy = op === 'assign-policy' || op === 'unassign-policy';

  return (
    <div className="flex flex-col gap-2">
      {bulk !== undefined && selection.selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-subtle px-3 py-2 text-sm"
        >
          <span className="font-medium">{selection.selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setOp('revoke')}>
            Revoke
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOp('activate')}>
            Reactivate
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOp('delete')}>
            Delete
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {bulk.policies.ok ? (
            <>
              <select
                aria-label="Policy"
                className={CONTROL}
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
              >
                <option value="">Policy…</option>
                {bulk.policies.value.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name} ({choice.id}){choice.active ? '' : ' — inactive'}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={policy === ''}
                onClick={() => setOp('assign-policy')}
              >
                Apply policy
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={policy === ''}
                onClick={() => setOp('unassign-policy')}
              >
                Remove policy
              </Button>
            </>
          ) : (
            <span className="font-mono text-xs text-danger">
              Policies unavailable: {bulk.policies.error}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={selection.clear}>
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {bulk !== undefined && (
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select every key on this page"
                    checked={rows.length > 0 && selection.selected.size === rows.length}
                    onChange={selection.toggleAll}
                  />
                </th>
              )}
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Policy</th>
              <th className="px-3 py-2 font-medium">Rate</th>
              <th className="px-3 py-2 font-medium">Quota</th>
              <th className="px-3 py-2 font-medium">Expires</th>
              <th className="px-3 py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.hash}
                row={row}
                selectable={bulk !== undefined}
                selected={selection.selected.has(row.hash)}
                onToggle={() => selection.toggle(row.hash)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {bulk !== undefined && op !== null && (!needsPolicy || policy !== '') && (
        <BulkReview
          title={`${verb(op, policy)} ${items.length} key${items.length === 1 ? '' : 's'}?`}
          description={<KeyOpNotes op={op} policy={policy} environment={bulk.environment.label} />}
          items={items}
          confirmLabel={verb(op, policy)}
          destructive={op === 'delete' || op === 'revoke'}
          run={() =>
            runBulk(bulk.environment.id, {
              collection: 'keys',
              op,
              ids: items.map((item) => item.id),
              ...(needsPolicy ? { policy } : {}),
            })
          }
          onClose={() => setOp(null)}
          onFinished={() => {
            selection.clear();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function verb(op: KeyBulkOp, policy: string): string {
  const words = describeBulkOp({ collection: 'keys', op, policy });
  return op === 'activate' ? 'Reactivate' : `${words[0].toUpperCase()}${words.slice(1)}`;
}

function KeyOpNotes({
  op,
  policy,
  environment,
}: {
  op: KeyBulkOp;
  policy: string;
  environment: string;
}) {
  const live = `In ${environment}. Key changes are live at once: no reload.`;
  const perKey =
    'g2way has no batch endpoint: each key is its own gateway call, audited on its own, and one failure does not stop the rest.';
  switch (op) {
    case 'revoke':
      return (
        <>
          <span>A soft revoke: each key stays stored but fails auth from its next request.</span>
          <span>{live}</span>
          <span>{perKey}</span>
        </>
      );
    case 'activate':
      return (
        <>
          <span>Each key authenticates again from its next request.</span>
          <span>{live}</span>
          <span>{perKey}</span>
        </>
      );
    case 'delete':
      return (
        <>
          <span className="text-danger">
            A hard delete: each key stops working at once and cannot be restored. Its dashboard
            label, owner and notes go with it (kept in the audit log).
          </span>
          <span>{live}</span>
          <span>{perKey}</span>
        </>
      );
    case 'assign-policy':
      return (
        <>
          <span>
            Each key applies <span className="font-mono">{policy}</span>, replacing any policy it
            applies now (g2way applies at most one). The policy&apos;s rate, quota and access then
            replace the key&apos;s own.
          </span>
          <span>{live}</span>
          <span>{perKey}</span>
        </>
      );
    case 'unassign-policy':
      return (
        <>
          <span>
            Keys applying <span className="font-mono">{policy}</span> stop applying it; others are
            left unchanged. Their own rate, quota and access apply again, and a key with no access
            entries may then call <strong>every API</strong>.
          </span>
          <span>{live}</span>
          <span>{perKey}</span>
        </>
      );
  }
}

function Row({
  row,
  selectable,
  selected,
  onToggle,
}: {
  row: KeyListRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const href = `/keys/view/${encodeURIComponent(row.hash)}`;
  const check = selectable && (
    <td className="px-3 py-2">
      <input
        type="checkbox"
        aria-label={`Select ${row.title ?? row.short}`}
        checked={selected}
        onChange={onToggle}
      />
    </td>
  );
  const owner = (
    <td className="px-3 py-2 text-xs">{row.owner ?? <span className="text-muted">—</span>}</td>
  );
  if (row.error !== null) {
    return (
      <tr className="border-t border-border align-top">
        {check}
        <td className="px-3 py-2">
          <Link href={href} className="font-mono text-xs hover:underline">
            {row.title ?? row.short}
          </Link>
        </td>
        {owner}
        <td colSpan={5} className="px-3 py-2 font-mono text-xs text-danger">
          {row.error}
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-border align-top">
      {check}
      <td className="px-3 py-2">
        <Link href={href} className="font-medium hover:underline">
          {row.title ?? <span className="text-muted italic">no label or alias</span>}
        </Link>
        {row.alias !== null && <p className="text-xs text-muted">alias {row.alias}</p>}
        <p className="font-mono text-xs text-muted" title={row.hash}>
          {row.short}
        </p>
      </td>
      {owner}
      <td className="px-3 py-2 font-mono text-xs">{row.policy ?? '—'}</td>
      <td className="px-3 py-2 font-mono text-xs">{row.rate}</td>
      <td className="px-3 py-2 font-mono text-xs">{row.quota}</td>
      <td className="px-3 py-2 text-xs">
        {row.expiresAt === null ? (
          'never'
        ) : (
          <time dateTime={new Date(row.expiresAt * 1000).toISOString()}>
            {new Date(row.expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC
          </time>
        )}
      </td>
      <td className="px-3 py-2">
        {row.state === 'revoked' ? (
          <Badge variant="secondary" title="Soft-revoked: fails auth, still stored">
            revoked
          </Badge>
        ) : row.state === 'expired' ? (
          <Badge variant="outline" className="border-warning/40 text-warning">
            expired
          </Badge>
        ) : (
          <Badge variant="outline" className="border-success/40 text-success">
            active
          </Badge>
        )}
        {row.everyApi && (
          <Badge
            variant="outline"
            className="ml-1 border-warning/40 text-warning"
            title="No access entries and no policy: the key may call every API"
          >
            every API
          </Badge>
        )}
      </td>
    </tr>
  );
}
