import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
} from '@/lib/g2/environments';
import { KEY_PAGE_SIZE, loadKeyPage, type KeyPage, type KeyRow } from '@/lib/g2/keys';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { isExpired, shortHash, summariseKey } from '@/lib/keys/session';
import { describeQuota, describeRate } from '@/lib/policies/list';

export const metadata: Metadata = { title: 'Keys' };

/**
 * The selected environment's keys. The gateway lists hashes only, so each row
 * costs a session read: the list pages ({@link KEY_PAGE_SIZE} per page), and
 * the page number lives in the query string.
 */
export default async function KeysPage({ searchParams }: PageProps<'/keys'>) {
  const user = await requirePermission('keys:read');
  const canWrite = can(user.role, 'keys:write');
  const params = await searchParams;
  const page = typeof params.page === 'string' ? Number.parseInt(params.page, 10) : 1;
  const deleted = typeof params.deleted === 'string' ? params.deleted : null;

  let list: KeyPage;
  let label: string;
  try {
    list = await loadKeyPage(await selectedEnvironmentId(), page);
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

  if (!list.keys.ok) {
    return (
      <Page environment={label} canWrite={canWrite}>
        <Problem title="GET /g2/keys failed">
          <p className="font-mono text-xs break-all">
            {list.keys.error}
            {list.keys.status !== undefined && ` (HTTP ${list.keys.status})`}
          </p>
        </Problem>
      </Page>
    );
  }

  const { items, total, pages, page: current } = list.keys.value;
  const first = (current - 1) * KEY_PAGE_SIZE + 1;
  const nowSecs = Math.floor(list.fetchedAt / 1000);

  return (
    <Page environment={label} canWrite={canWrite}>
      {deleted && (
        <Notice message={`Deleted key ${shortHash(deleted)}. It stopped working at once.`} />
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {total === 0
          ? 'No keys.'
          : `${total} key${total === 1 ? '' : 's'}${pages > 1 ? ` · showing ${first}–${first + items.length - 1}` : ''}`}{' '}
        · listed by hash, the only handle the gateway keeps; the raw key is shown once, when it is
        created.
      </p>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
          No keys in this environment yet.
        </p>
      ) : (
        <KeyTable rows={items} nowSecs={nowSecs} />
      )}
      {pages > 1 && <Pager page={current} pages={pages} />}
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
          <h1 className="text-2xl font-semibold tracking-tight">Keys</h1>
          <p className="mt-1 text-sm text-muted">
            API keys, their limits and state
            {environment && (
              <>
                {' '}
                in <span className="font-medium text-foreground">{environment}</span>
              </>
            )}
            . Key changes are live at once.
          </p>
        </div>
        {canWrite && (
          <Button asChild>
            <Link href="/keys/new">New key</Link>
          </Button>
        )}
      </header>
      {children}
    </div>
  );
}

function KeyTable({ rows, nowSecs }: { rows: readonly KeyRow[]; nowSecs: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Policy</th>
            <th className="px-3 py-2 font-medium">Rate</th>
            <th className="px-3 py-2 font-medium">Quota</th>
            <th className="px-3 py-2 font-medium">Expires</th>
            <th className="px-3 py-2 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ hash, session }) => {
            const href = `/keys/view/${encodeURIComponent(hash)}`;
            if (!session.ok) {
              return (
                <tr key={hash} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <Link href={href} className="font-mono text-xs hover:underline">
                      {shortHash(hash)}
                    </Link>
                  </td>
                  <td colSpan={5} className="px-3 py-2 font-mono text-xs text-danger">
                    {session.error}
                    {session.status !== undefined && ` (HTTP ${session.status})`}
                  </td>
                </tr>
              );
            }
            const key = summariseKey(hash, session.value);
            const expired = isExpired(key.expiresAt, nowSecs);
            return (
              <tr key={hash} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <Link href={href} className="font-medium hover:underline">
                    {key.alias ?? <span className="text-muted italic">no alias</span>}
                  </Link>
                  <p className="font-mono text-xs text-muted" title={hash}>
                    {shortHash(hash)}
                  </p>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{key.policy ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {key.policy ? 'from policy' : describeRate(key.rate)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {key.policy ? 'from policy' : describeQuota(key.quota)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {key.expiresAt === null ? (
                    'never'
                  ) : (
                    <time dateTime={new Date(key.expiresAt * 1000).toISOString()}>
                      {new Date(key.expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}{' '}
                      UTC
                    </time>
                  )}
                </td>
                <td className="px-3 py-2">
                  {!key.active ? (
                    <Badge variant="secondary" title="Soft-revoked: fails auth, still stored">
                      revoked
                    </Badge>
                  ) : expired ? (
                    <Badge variant="outline" className="border-warning/40 text-warning">
                      expired
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-success/40 text-success">
                      active
                    </Badge>
                  )}
                  {!key.policy && key.apis.length === 0 && (
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
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pager({ page, pages }: { page: number; pages: number }) {
  const link = (target: number, label: string) => (
    <Button asChild variant="outline" size="sm">
      <Link href={`/keys?page=${target}`}>{label}</Link>
    </Button>
  );
  return (
    <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
      {page > 1 && link(page - 1, 'Previous')}
      <span className="text-muted">
        Page {page} of {pages}
      </span>
      {page < pages && link(page + 1, 'Next')}
    </nav>
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
