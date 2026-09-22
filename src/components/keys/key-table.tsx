'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BulkReview, useSelection, type BulkItem } from '@/components/bulk/bulk-review';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BULK_MAX, chunkIds, describeBulkOp, runBulkChunked, type KeyBulkOp } from '@/lib/bulk/ops';
import type { KeyFilter } from '@/lib/keys/filter';
import type { KeyListRow } from '@/lib/keys/list-row';
import type { KeyMatchSelection } from '@/lib/keys/matches';

type PolicyChoice = { id: string; name: string; active: boolean };
type ResolvedMatches = Extract<KeyMatchSelection, { ok: true }>;
type EveryMatch =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; selection: ResolvedMatches };

const CONTROL =
  'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The `/keys` table. With `keys:write` (`bulk` set) rows can be selected and
 * revoked, reactivated, deleted, or given or relieved of one policy in bulk:
 * reviewed first, then one audited gateway call per key, reported per key.
 *
 * On a filtered list (`bulk.everyMatch` set), "Select every match" swaps the
 * on-screen selection for the filter's whole match set, resolved server-side
 * by the search loader at that moment (capped, and never including a key whose
 * session could not be read); the review dialog lists it all, and it is sent
 * in requests of at most {@link BULK_MAX}.
 */
export function KeyTable({
  rows,
  bulk,
}: {
  rows: readonly KeyListRow[];
  bulk?: {
    environment: { id: string; label: string };
    policies: { ok: true; value: PolicyChoice[] } | { ok: false; error: string };
    everyMatch?: {
      filter: KeyFilter;
      resolve: (environmentId: string, filter: KeyFilter) => Promise<KeyMatchSelection>;
    };
  };
}) {
  const router = useRouter();
  const selection = useSelection(rows.map((row) => row.hash));
  const [policy, setPolicy] = useState('');
  const [op, setOp] = useState<KeyBulkOp | null>(null);
  const [every, setEvery] = useState<EveryMatch | null>(null);
  const matches = every?.state === 'ready' ? every.selection : null;
  const chosen = matches?.items ?? rows.filter((row) => selection.selected.has(row.hash));
  const checked = matches === null ? selection.selected : new Set(chosen.map((row) => row.hash));
  const selectedCount = matches === null ? selection.selected.size : matches.items.length;

  const selectEveryMatch = async () => {
    if (bulk?.everyMatch === undefined) return;
    setEvery({ state: 'loading' });
    try {
      const answer = await bulk.everyMatch.resolve(bulk.environment.id, bulk.everyMatch.filter);
      setEvery(
        answer.ok ? { state: 'ready', selection: answer } : { state: 'error', error: answer.error },
      );
    } catch (error) {
      setEvery({ state: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };
  const clearAll = () => {
    setEvery(null);
    selection.clear();
  };

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
      {bulk !== undefined && (selection.selected.size > 0 || every !== null) && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-subtle px-3 py-2 text-sm"
        >
          <span className="font-medium">
            {selectedCount} selected
            {matches !== null && (
              <span className="font-normal text-muted"> · every readable match, all pages</span>
            )}
          </span>
          {bulk.everyMatch !== undefined && every?.state !== 'ready' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={every?.state === 'loading'}
              onClick={selectEveryMatch}
              title="Read the whole match set of this filter now, across every page"
            >
              {every?.state === 'loading' ? 'Finding every match…' : 'Select every match'}
            </Button>
          )}
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
          <Button size="sm" variant="ghost" onClick={clearAll}>
            Clear
          </Button>
          {every?.state === 'error' && (
            <p role="alert" className="w-full font-mono text-xs break-all text-danger">
              Could not select every match: {every.error}
            </p>
          )}
          {matches !== null && <MatchSetNotes matches={matches} />}
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
                    checked={rows.length > 0 && rows.every((row) => checked.has(row.hash))}
                    onChange={() => {
                      setEvery(null);
                      selection.toggleAll();
                    }}
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
                selected={checked.has(row.hash)}
                onToggle={() => {
                  setEvery(null);
                  selection.toggle(row.hash);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      {bulk !== undefined && op !== null && (!needsPolicy || policy !== '') && (
        <BulkReview
          title={`${verb(op, policy)} ${items.length} key${items.length === 1 ? '' : 's'}?`}
          description={
            <>
              <KeyOpNotes op={op} policy={policy} environment={bulk.environment.label} />
              {matches !== null && <MatchSetNotes matches={matches} review />}
            </>
          }
          items={items}
          confirmLabel={verb(op, policy)}
          destructive={op === 'delete' || op === 'revoke'}
          run={() =>
            runBulkChunked(bulk.environment.id, {
              collection: 'keys',
              op,
              ids: items.map((item) => item.id),
              ...(needsPolicy ? { policy } : {}),
            })
          }
          onClose={() => setOp(null)}
          onFinished={() => {
            clearAll();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * What "every match" covers, said plainly: when it was read, what it left out
 * (keys that could not be read), where it stopped (the scan cap), and, in the
 * review dialog, how many requests it will take.
 */
function MatchSetNotes({
  matches,
  review = false,
}: {
  matches: ResolvedMatches;
  review?: boolean;
}) {
  const { items, scan, unreadable, truncatedAt, labelsError, resolvedAt } = matches;
  const requests = chunkIds(items).length;
  const s = (n: number, one = '', many = 's') => (n === 1 ? one : many);
  return (
    <span className="flex w-full flex-col gap-1 text-xs">
      <span className={review ? undefined : 'text-muted'}>
        Every match of this filter, read at{' '}
        <time dateTime={new Date(resolvedAt).toISOString()}>
          {new Date(resolvedAt).toISOString().slice(11, 19)} UTC
        </time>
        : {items.length} key{s(items.length)} among {scan.scanned} of {scan.total} read.
        {review &&
          requests > 1 &&
          ` Sent as ${requests} requests of at most ${BULK_MAX} keys, one after another; a request refused whole stops the rest.`}
      </span>
      {truncatedAt !== null && (
        <span className="rounded-md border border-warning/40 bg-warning/5 px-2 py-1 text-warning">
          Incomplete: the search stops after {truncatedAt} session reads, so this selection covers
          only the keys that were read. {scan.total - scan.scanned} key
          {s(scan.total - scan.scanned, ' was', 's were')} not read, and any matches among them are
          not included.
        </span>
      )}
      {unreadable > 0 && (
        <span className="text-danger">
          {unreadable} key{s(unreadable)} could not be read and {s(unreadable, 'is', 'are')} not
          included: {s(unreadable, 'its', 'their')} session read failed, so whether{' '}
          {s(unreadable, 'it matches', 'they match')} is unchecked. Act on{' '}
          {s(unreadable, 'it', 'them')} one at a time.
        </span>
      )}
      {labelsError !== null && (
        <span className="text-danger">
          Labels and owners were unavailable, so they were not searched: {labelsError}
        </span>
      )}
    </span>
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
