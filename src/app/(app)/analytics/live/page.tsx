import type { Metadata } from 'next';
import Link from 'next/link';
import { DrillBar, type DrillChip } from '@/components/analytics/drill-bar';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { LiveTail } from '@/components/analytics/live-tail';
import {
  DIMENSION_LABELS,
  describeValue,
  drillHref,
  parseDrill,
  type Drill,
} from '@/lib/analytics/drill';
import { loadLiveRequests } from '@/lib/analytics/live';
import { loadIngestHealth } from '@/lib/analytics/load-health';
import { TAIL_MAX_AGE_MS, liveHref } from '@/lib/analytics/tail';
import { DEFAULT_TRAFFIC_RANGE } from '@/lib/analytics/traffic';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { shortHash } from '@/lib/keys/session';

export const metadata: Metadata = { title: 'Live requests' };

/**
 * The live request inspector (ADR-0014): the selected environment's newest
 * requests, from the tail the ingest worker keeps in the dashboard database.
 * The first snapshot is rendered here; `LiveTail` polls for the rest. Takes
 * the drill-down's `?api=` and one of `?key=`, `?status=`, `?method=`,
 * `?path=` (a template), so a selection carries over from `/analytics`.
 */
export default async function LiveRequestsPage({ searchParams }: PageProps<'/analytics/live'>) {
  const user = await requirePermission('analytics:inspect');
  const params = await searchParams;
  const keys = can(user.role, 'keys:read');
  const drill = parseDrill(params, { keys });

  let target: GatewayTarget;
  try {
    target = resolveEnvironment(await selectedEnvironmentId());
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return (
        <Page>
          <section
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
          >
            <p className="mb-1 font-medium text-danger">Cannot pick a gateway</p>
            <p className="font-mono text-xs">{error.message}</p>
          </section>
        </Page>
      );
    }
    throw error;
  }

  const { health, configProblems, now } = await loadIngestHealth(target);
  const snapshot = await loadLiveRequests(target, drill, user.role, now);
  const selection = { apiId: drill.apiId, focus: drill.focus };
  const chips = await selectionChips(target, drill);
  const trafficHref = drillHref({ range: DEFAULT_TRAFFIC_RANGE, ...selection, by: null });

  return (
    <Page environment={target.label}>
      <IngestHealthPanel health={health} configProblems={configProblems} now={now} />
      <DrillBar
        chips={chips}
        notes={drill.notes}
        clearHref={liveHref({ apiId: null, focus: null })}
      />
      <p className="text-sm text-muted">
        The newest requests the ingest worker drained in the last {TAIL_MAX_AGE_MS / 60_000}{' '}
        minutes, newest first: a sample for watching traffic arrive, not a log. At high rates only
        the newest of each drained batch are kept. Paths are shown as the client sent them, without
        the query string (the gateway does not record it); client addresses and User-Agents are
        never stored.{' '}
        <Link className="underline" href={trafficHref}>
          Traffic for this selection
        </Link>
      </p>
      <LiveTail
        key={liveHref(selection)}
        initial={snapshot}
        selection={selection}
        showKeys={keys}
      />
    </Page>
  );
}

/** The selection as removable chips, as on `/analytics`. */
async function selectionChips(target: GatewayTarget, drill: Drill): Promise<DrillChip[]> {
  const chips: DrillChip[] = [];
  if (drill.apiId !== null) {
    chips.push({
      dimension: 'API',
      ...describeValue('api', drill.apiId, { shortHash }),
      removeHref: liveHref({ apiId: null, focus: drill.focus }),
      page: null,
    });
  }
  if (drill.focus !== null) {
    const { dimension, value } = drill.focus;
    let keyLabel: string | null = null;
    if (dimension === 'key' && value !== '') {
      const found = await listKeyMetadata(getDatabase(), getOrgId(), target.id, [value]);
      keyLabel = found.get(value)?.label ?? null;
    }
    chips.push({
      dimension: DIMENSION_LABELS[dimension],
      ...describeValue(dimension, value, { keyLabel, shortHash }),
      removeHref: liveHref({ apiId: drill.apiId, focus: null }),
      page: null,
    });
  }
  return chips;
}

function Page({ children, environment }: { children: React.ReactNode; environment?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Live requests</h1>
        <p className="mt-1 text-sm text-muted">
          Recent individual requests
          {environment && (
            <>
              {' '}
              for <span className="font-medium text-foreground">{environment}</span>
            </>
          )}
          , from the gateway&apos;s analytics records.
        </p>
      </header>
      {children}
    </div>
  );
}
