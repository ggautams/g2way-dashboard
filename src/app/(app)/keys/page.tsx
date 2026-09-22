import type { Metadata } from 'next';
import Link from 'next/link';
import { KeyTable } from '@/components/keys/key-table';
import { OrphanPrune, type OrphanRow } from '@/components/keys/orphan-prune';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listAllKeyMetadata, listKeyMetadata } from '@/lib/db/key-metadata';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  listEnvironments,
} from '@/lib/g2/environments';
import type { Outcome } from '@/lib/g2/gateway-status';
import {
  KEY_PAGE_SIZE,
  KEY_SCAN_LIMIT,
  loadKeyPage,
  loadKeySearch,
  loadPolicyChoices,
  type KeyRow,
  type KeySearchScan,
  type PolicyChoices,
} from '@/lib/g2/keys';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import {
  NO_POLICY,
  isFiltering,
  keyFilterQuery,
  parseKeyFilter,
  type KeyFilter,
  type KeyLabels,
} from '@/lib/keys/filter';
import { toKeyListRow } from '@/lib/keys/list-row';
import { resolveKeyMatchesAction } from '@/lib/keys/match-actions';
import { pruneKeyOrphansAction } from '@/lib/keys/orphan-actions';
import { findOrphans } from '@/lib/keys/orphans';
import { shortHash, type Paged } from '@/lib/keys/session';

export const metadata: Metadata = { title: 'Keys' };

const CONTROL =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

type ListedKeys = Paged<KeyRow> & { hashes: string[]; scan?: KeySearchScan };

/**
 * The selected environment's keys. The gateway lists hashes only, so each row
 * costs a session read: the plain list pages ({@link KEY_PAGE_SIZE} per page).
 * A search or filter (`?q=&policy=&state=`, `lib/keys/filter.ts`) matches label
 * and owner in the dashboard database and reads sessions for alias, policy and
 * state, at most {@link KEY_SCAN_LIMIT} of them, and says when it stopped short.
 */
export default async function KeysPage({ searchParams }: PageProps<'/keys'>) {
  const user = await requirePermission('keys:read');
  const canWrite = can(user.role, 'keys:write');
  const params = await searchParams;
  const page = typeof params.page === 'string' ? Number.parseInt(params.page, 10) : 1;
  const deleted = typeof params.deleted === 'string' ? params.deleted : null;
  const filter = parseKeyFilter(params);
  const filtering = isFiltering(filter);

  let environment: string;
  let fetchedAt: number;
  let keys: Outcome<ListedKeys>;
  let labels: Outcome<Map<string, KeyLabels>> = { ok: true, value: new Map() };
  let label: string;
  try {
    const selected = await selectedEnvironmentId();
    if (filtering) {
      const search = await loadKeySearch(selected, filter, page, {
        labelsFor: (env, hashes) => listKeyMetadata(getDatabase(), getOrgId(), env, hashes),
      });
      ({ environment, fetchedAt, keys, labels } = search);
    } else {
      ({ environment, fetchedAt, keys } = await loadKeyPage(selected, page));
    }
    label = listEnvironments().find(({ id }) => id === environment)?.label ?? environment;
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

  const policies = await loadPolicyChoices(environment);

  if (!keys.ok) {
    return (
      <Page environment={label} canWrite={canWrite}>
        <KeyFilterForm filter={filter} policies={policies} />
        <Problem title="GET /g2/keys failed">
          <p className="font-mono text-xs break-all">
            {keys.error}
            {keys.status !== undefined && ` (HTTP ${keys.status})`}
          </p>
        </Problem>
      </Page>
    );
  }

  const { items, total, pages, page: current, hashes, scan } = keys.value;
  const first = (current - 1) * KEY_PAGE_SIZE + 1;
  const nowSecs = Math.floor(fetchedAt / 1000);
  // Label and owner live in the dashboard database (ADR-0009 §7), by hash. A
  // search has already read them for every hash; the plain list reads a page's.
  if (!filtering) {
    try {
      labels = {
        ok: true,
        value: await listKeyMetadata(
          getDatabase(),
          getOrgId(),
          environment,
          items.map(({ hash }) => hash),
        ),
      };
    } catch (error) {
      labels = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const labelMap = labels.ok ? labels.value : new Map<string, KeyLabels>();
  const rows = items.map(({ hash, session }) =>
    toKeyListRow(hash, session, labelMap.get(hash), nowSecs),
  );

  // Metadata rows for keys the gateway no longer lists (deleted elsewhere).
  let orphans: OrphanRow[] = [];
  let orphanError: string | null = null;
  if (canWrite) {
    try {
      const check = findOrphans(
        { ok: true, value: hashes },
        await listAllKeyMetadata(getDatabase(), getOrgId(), environment),
      );
      if (check.ok) {
        orphans = check.orphans.map((row) => ({
          hash: row.keyHash,
          short: shortHash(row.keyHash),
          label: row.label,
          owner: row.owner,
          updatedAt: (row.updatedAt ?? row.createdAt)?.toISOString() ?? null,
        }));
      }
    } catch (error) {
      orphanError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <Page environment={label} canWrite={canWrite}>
      {deleted && (
        <Notice message={`Deleted key ${shortHash(deleted)}. It stopped working at once.`} />
      )}
      <KeyFilterForm filter={filter} policies={policies} />
      {scan !== undefined ? (
        <ScanReport scan={scan} filter={filter} labelsOk={labels.ok} />
      ) : (
        <p className="text-xs text-muted" aria-live="polite">
          {total === 0
            ? 'No keys.'
            : `${total} key${total === 1 ? '' : 's'}${pages > 1 ? ` · showing ${first}–${first + items.length - 1}` : ''}`}{' '}
          · listed by hash, the only handle the gateway keeps; the raw key is shown once, when it is
          created.
        </p>
      )}
      {!labels.ok && (
        <p role="alert" className="font-mono text-xs break-all text-danger">
          Labels and owners unavailable{filtering ? ', so they were not searched' : ''}:{' '}
          {labels.error}
        </p>
      )}
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
          {filtering ? (
            <>
              Nothing matches.{' '}
              <Link href="/keys" className="underline">
                Clear the filter
              </Link>
            </>
          ) : (
            'No keys in this environment yet.'
          )}
        </p>
      ) : (
        <KeyTable
          rows={rows}
          bulk={
            canWrite
              ? {
                  environment: { id: environment, label },
                  policies: policies.ok
                    ? { ok: true, value: policies.value }
                    : { ok: false, error: policies.error },
                  everyMatch: filtering ? { filter, resolve: resolveKeyMatchesAction } : undefined,
                }
              : undefined
          }
        />
      )}
      {pages > 1 && <Pager page={current} pages={pages} filter={filter} />}
      {orphanError !== null && (
        <p role="alert" className="font-mono text-xs break-all text-danger">
          Could not check for orphaned key metadata: {orphanError}
        </p>
      )}
      {orphans.length > 0 && (
        <OrphanPrune
          orphans={orphans}
          environment={{ id: environment, label }}
          action={pruneKeyOrphansAction}
        />
      )}
    </Page>
  );
}

function KeyFilterForm({ filter, policies }: { filter: KeyFilter; policies: PolicyChoices }) {
  return (
    <form role="search" className="flex flex-wrap items-end gap-2" action="/keys">
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
        Search
        <Input
          type="search"
          name="q"
          defaultValue={filter.q}
          placeholder="Label, owner, alias or hash prefix"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Policy
        {policies.ok ? (
          <select name="policy" defaultValue={filter.policy} className={CONTROL}>
            <option value="">Any</option>
            <option value={NO_POLICY}>No policy</option>
            {policies.value.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name} ({choice.id})
              </option>
            ))}
            {filter.policy !== '' &&
              filter.policy !== NO_POLICY &&
              !policies.value.some((choice) => choice.id === filter.policy) && (
                <option value={filter.policy}>{filter.policy} (not found)</option>
              )}
          </select>
        ) : (
          <Input
            name="policy"
            defaultValue={filter.policy}
            placeholder={`Policy id, or ${NO_POLICY} for none`}
            title={`Policies unavailable: ${policies.error}`}
          />
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        State
        <select name="state" defaultValue={filter.state} className={CONTROL}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
          <option value="expired">Expired</option>
        </select>
      </label>
      <Button type="submit" variant="outline">
        Filter
      </Button>
      {isFiltering(filter) && (
        <Button asChild variant="ghost">
          <Link href="/keys">Clear</Link>
        </Button>
      )}
    </form>
  );
}

/** How far a search got: an incomplete answer says so, with the reason. */
function ScanReport({
  scan,
  filter,
  labelsOk,
}: {
  scan: KeySearchScan;
  filter: KeyFilter;
  labelsOk: boolean;
}) {
  const truncated = scan.scanned < scan.total;
  return (
    <div className="flex flex-col gap-1 text-xs" aria-live="polite">
      <p className="text-muted">
        {scan.matched} match{scan.matched === 1 ? '' : 'es'} among {scan.scanned} of {scan.total}{' '}
        key{scan.total === 1 ? '' : 's'} read. Label and owner are matched in the dashboard
        database; alias, policy and state need one gateway read per key.
      </p>
      {truncated && (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-warning"
        >
          Incomplete: the search stops after {KEY_SCAN_LIMIT} session reads, and{' '}
          {scan.total - scan.scanned} key{scan.total - scan.scanned === 1 ? ' was' : 's were'} not
          read.{' '}
          {filter.q !== '' && labelsOk ? 'Keys whose label or owner match were read first; ' : ''}
          matches by alias, policy or state among the unread keys are missing. Narrow the search, or
          give keys labels so they are found without a gateway read.
        </p>
      )}
      {scan.unchecked > 0 && (
        <p className="text-danger">
          {scan.unchecked} key{scan.unchecked === 1 ? '' : 's'} could not be read and{' '}
          {scan.unchecked === 1 ? 'is' : 'are'} listed unchecked.
        </p>
      )}
    </div>
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

function Pager({ page, pages, filter }: { page: number; pages: number; filter: KeyFilter }) {
  const link = (target: number, label: string) => (
    <Button asChild variant="outline" size="sm">
      <Link href={`/keys${keyFilterQuery(filter, target)}`}>{label}</Link>
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
