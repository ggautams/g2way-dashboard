import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import {
  AUTH_MODES,
  filterApis,
  parseApiFilter,
  summarise,
  type ApiFilter,
  type ApiSummary,
} from '@/lib/apis/list';
import { loadApis, type ApiList } from '@/lib/g2/apis';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export const metadata: Metadata = { title: 'APIs' };

/**
 * The selected environment's API definitions, as stored. Search and filters
 * live in the query string (a plain GET form), so a filtered view is a link.
 */
export default async function ApisPage({ searchParams }: PageProps<'/apis'>) {
  const user = await requirePermission('apis:read');
  const canWrite = can(user.role, 'apis:write');
  const filter = parseApiFilter(await searchParams);

  let list: ApiList;
  let label: string;
  try {
    list = await loadApis(await selectedEnvironmentId());
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

  if (!list.apis.ok) {
    return (
      <Page environment={label} canWrite={canWrite}>
        <Problem title="GET /g2/apis failed">
          <p className="font-mono text-xs break-all">
            {list.apis.error}
            {list.apis.status !== undefined && ` (HTTP ${list.apis.status})`}
          </p>
        </Problem>
      </Page>
    );
  }

  const all = list.apis.value.map(summarise);
  const shown = filterApis(all, filter);
  const inactive = all.filter((api) => !api.active).length;

  return (
    <Page environment={label} canWrite={canWrite}>
      <FilterForm filter={filter} />
      <p className="text-xs text-muted" aria-live="polite">
        {shown.length === all.length
          ? `${all.length} API${all.length === 1 ? '' : 's'}`
          : `${shown.length} of ${all.length} APIs`}
        {inactive > 0 && ` · ${inactive} inactive`} · as stored; changes since the last reload are
        listed here before they route.
      </p>
      {all.length === 0 ? (
        <Empty>No API definitions in this environment yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>
          Nothing matches.{' '}
          <Link href="/apis" className="underline">
            Clear the filters
          </Link>
        </Empty>
      ) : (
        <ApiTable apis={shown} />
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
          <h1 className="text-2xl font-semibold tracking-tight">APIs</h1>
          <p className="mt-1 text-sm text-muted">
            API definitions
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
            <Link href="/apis/new">New API</Link>
          </Button>
        )}
      </header>
      {children}
    </div>
  );
}

/** Native selects, so the filter stays a plain GET form that works without JS. */
const CONTROL =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

function FilterForm({ filter }: { filter: ApiFilter }) {
  return (
    <form role="search" className="flex flex-wrap items-end gap-2" action="/apis">
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
        Search
        <Input
          type="search"
          name="q"
          defaultValue={filter.q}
          placeholder="Name, id, listen path or target"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        State
        <select name="state" defaultValue={filter.state} className={CONTROL}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Auth
        <select name="auth" defaultValue={filter.auth} className={CONTROL}>
          <option value="all">Any</option>
          {AUTH_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="outline">
        Filter
      </Button>
    </form>
  );
}

function ApiTable({ apis }: { apis: readonly ApiSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">API</th>
            <th className="px-3 py-2 font-medium">Listen path</th>
            <th className="px-3 py-2 font-medium">Upstream</th>
            <th className="px-3 py-2 font-medium">Auth</th>
            <th className="px-3 py-2 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {apis.map((api) => (
            <tr key={api.apiId} className="border-t border-border align-top">
              <td className="px-3 py-2">
                <Link
                  href={`/apis/${encodeURIComponent(api.apiId)}`}
                  className="font-medium hover:underline"
                >
                  {api.name}
                </Link>
                <p className="font-mono text-xs text-muted">{api.apiId}</p>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{api.listenPath}</td>
              <td className="px-3 py-2 font-mono text-xs break-all">
                {api.targets[0]}
                {api.targets.length > 1 && (
                  <span className="ml-1 text-muted" title={api.targets.join('\n')}>
                    +{api.targets.length - 1} more (round robin)
                  </span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{api.authMode}</td>
              <td className="px-3 py-2">
                {api.active ? (
                  <Badge variant="outline" className="border-success/40 text-success">
                    active
                  </Badge>
                ) : (
                  <Badge variant="secondary" title="Loaded and listed, never routed to">
                    inactive
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
