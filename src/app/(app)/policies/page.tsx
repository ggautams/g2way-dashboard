import type { Metadata } from 'next';
import Link from 'next/link';
import { PolicyTable } from '@/components/policies/policy-table';
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
import { filterPolicies, summarisePolicy } from '@/lib/policies/list';

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
        <PolicyTable
          policies={shown}
          staged={[...staged]}
          bulk={canWrite ? { environment: { id: list.environment, label } } : undefined}
        />
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
