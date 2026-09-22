import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listPendingChanges } from '@/lib/db/pending';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  listEnvironments,
} from '@/lib/g2/environments';
import { loadPolicies, type PolicyList } from '@/lib/g2/policies';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import {
  describeQuota,
  describeRate,
  filterPolicies,
  summarisePolicy,
  type PolicySummary,
} from '@/lib/policies/list';

export const metadata: Metadata = { title: 'Policies' };

/**
 * The selected environment's policies, as stored. The search lives in the
 * query string (a plain GET form), so a filtered view is a link.
 */
export default async function PoliciesPage({ searchParams }: PageProps<'/policies'>) {
  const user = await requirePermission('policies:read');
  const canWrite = can(user.role, 'policies:write');
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const deleted = typeof params.deleted === 'string' ? params.deleted : null;

  let list: PolicyList;
  let label: string;
  try {
    list = await loadPolicies(await selectedEnvironmentId());
    label = listEnvironments().find(({ id }) => id === list.environment)?.label ?? list.environment;
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return (
        <Page>
          <Problem title="Cannot pick a gateway">
            <p className="font-mono text-xs">{error.message}</p>
          </Problem>
        </Page>
      );
    }
    throw error;
  }

  if (!list.policies.ok) {
    return (
      <Page environment={label} canWrite={canWrite}>
        <Problem title="GET /g2/policies failed">
          <p className="font-mono text-xs break-all">
            {list.policies.error}
            {list.policies.status !== undefined && ` (HTTP ${list.policies.status})`}
          </p>
        </Problem>
      </Page>
    );
  }

  const all = list.policies.value.map(summarisePolicy);
  const { changes } = await listPendingChanges(getDatabase(), getOrgId(), list.environment);
  const staged = new Set(
    changes.filter((c) => c.action.startsWith('policy.')).map((c) => c.target ?? ''),
  );
  const shown = filterPolicies(all, q);
  const inactive = all.filter((policy) => !policy.active).length;

  return (
    <Page environment={label} canWrite={canWrite}>
      {deleted && (
        <Notice
          message={`Deleted ${deleted}. Keys referencing it are unaffected until the gateway reloads.`}
        />
      )}
      <form role="search" className="flex flex-wrap items-end gap-2" action="/policies">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
          Search
          <Input type="search" name="q" defaultValue={q} placeholder="Name, id or api_id" />
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <p className="text-xs text-muted" aria-live="polite">
        {shown.length === all.length
          ? `${all.length} polic${all.length === 1 ? 'y' : 'ies'}`
          : `${shown.length} of ${all.length} policies`}
        {inactive > 0 && ` · ${inactive} inactive`} · as stored; changes since the last reload are
        listed here before keys see them.
      </p>
      {all.length === 0 ? (
        <Empty>No policies in this environment yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>
          Nothing matches.{' '}
          <Link href="/policies" className="underline">
            Clear the search
          </Link>
        </Empty>
      ) : (
        <PolicyTable policies={shown} staged={staged} />
      )}
    </Page>
  );
}

function Page({
  environment,
  canWrite = false,
  children,
}: {
  environment?: string;
  canWrite?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
          <p className="mt-1 text-sm text-muted">
            Rate, quota and API access bundles that keys apply
            {environment && (
              <>
                {' '}
                in <span className="font-medium text-foreground">{environment}</span>
              </>
            )}
            .
          </p>
        </div>
        {canWrite && (
          <Button asChild>
            <Link href="/policies/new">New policy</Link>
          </Button>
        )}
      </header>
      {children}
    </div>
  );
}

function PolicyTable({
  policies,
  staged,
}: {
  policies: readonly PolicySummary[];
  /** Ids with saved changes not yet live (no reload since). */
  staged: ReadonlySet<string>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
          <tr>
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
                {staged.has(policy.policyId) && (
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
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
      {children}
    </p>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
      <p className="mb-1 font-medium text-danger">{title}</p>
      {children}
    </section>
  );
}
