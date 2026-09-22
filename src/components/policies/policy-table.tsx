'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BulkReview, useSelection } from '@/components/bulk/bulk-review';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { runBulk } from '@/lib/bulk/ops';
import { describeQuota, describeRate, type PolicySummary } from '@/lib/policies/list';

/**
 * The `/policies` table. With `policies:write` (`bulk` set) rows can be
 * selected and deleted in bulk: reviewed first, then one audited gateway call
 * per policy, reported per policy. Deletes are staged until the gateway reloads.
 */
export function PolicyTable({
  policies,
  staged,
  bulk,
}: {
  policies: readonly PolicySummary[];
  /** Ids with saved changes not yet live (no reload since). */
  staged: readonly string[];
  bulk?: { environment: { id: string; label: string } };
}) {
  const router = useRouter();
  const selection = useSelection(policies.map((policy) => policy.policyId));
  const [reviewing, setReviewing] = useState(false);
  const stagedSet = new Set(staged);
  const items = policies
    .filter((policy) => selection.selected.has(policy.policyId))
    .map((policy) => ({
      id: policy.policyId,
      label: policy.name,
      detail: `${policy.policyId}${policy.active ? '' : ' · inactive'}`,
    }));

  return (
    <div className="flex flex-col gap-2">
      {bulk !== undefined && selection.selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-subtle px-3 py-2 text-sm"
        >
          <span className="font-medium">{selection.selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>
            Delete
          </Button>
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
                    aria-label="Select every policy shown"
                    checked={policies.length > 0 && selection.selected.size === policies.length}
                    onChange={selection.toggleAll}
                  />
                </th>
              )}
              <th className="px-3 py-2 font-medium">Policy</th>
              <th className="px-3 py-2 font-medium">Rate</th>
              <th className="px-3 py-2 font-medium">Quota</th>
              <th className="px-3 py-2 font-medium">APIs</th>
              <th className="px-3 py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy) => (
              <tr key={policy.policyId} className="border-t border-border align-top">
                {bulk !== undefined && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${policy.name}`}
                      checked={selection.selected.has(policy.policyId)}
                      onChange={() => selection.toggle(policy.policyId)}
                    />
                  </td>
                )}
                <td className="px-3 py-2">
                  <Link
                    href={`/policies/view/${encodeURIComponent(policy.policyId)}`}
                    className="font-medium hover:underline"
                  >
                    {policy.name}
                  </Link>
                  <p className="font-mono text-xs text-muted">{policy.policyId}</p>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{describeRate(policy.rate)}</td>
                <td className="px-3 py-2 font-mono text-xs">{describeQuota(policy.quota)}</td>
                <td className="px-3 py-2 text-xs">
                  {policy.apis.length === 0 ? (
                    <span className="text-warning" title="An empty access map grants every API">
                      every API
                    </span>
                  ) : (
                    <span className="font-mono" title={policy.apis.join('\n')}>
                      {policy.apis.length <= 3
                        ? policy.apis.join(', ')
                        : `${policy.apis.slice(0, 3).join(', ')} +${policy.apis.length - 3} more`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {policy.active ? (
                    <Badge variant="outline" className="border-success/40 text-success">
                      active
                    </Badge>
                  ) : (
                    <Badge variant="secondary" title="Denies every key that references it">
                      inactive
                    </Badge>
                  )}
                  {stagedSet.has(policy.policyId) && (
                    <Badge
                      variant="outline"
                      className="ml-1 border-warning/40 text-warning"
                      title="Saved since the last reload: keys still get the previous version"
                    >
                      not live
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bulk !== undefined && reviewing && (
        <BulkReview
          title={`Delete ${items.length} polic${items.length === 1 ? 'y' : 'ies'}?`}
          description={
            <>
              <span>
                Deletes each policy from {bulk.environment.label}&apos;s storage. Keys that apply a
                deleted policy are refused once it is gone from the data plane.
              </span>
              <span className="font-medium text-warning">
                Not live until the gateway reloads (POST /g2/reload): until then keys keep getting
                the policies as they were.
              </span>
              <span>
                g2way has no batch endpoint: each policy is its own gateway call, audited on its
                own, and one failure does not stop the rest.
              </span>
            </>
          }
          items={items}
          confirmLabel="Delete"
          destructive
          run={() =>
            runBulk(bulk.environment.id, {
              collection: 'policies',
              op: 'delete',
              ids: items.map((item) => item.id),
            })
          }
          onClose={() => setReviewing(false)}
          onFinished={() => {
            selection.clear();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
