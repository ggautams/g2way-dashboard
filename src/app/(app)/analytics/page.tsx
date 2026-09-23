import type { Metadata } from 'next';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { TrafficPanel } from '@/components/analytics/traffic-panel';
import { IngestConfigError, parseIngestConfig } from '@/lib/analytics/config';
import { ingestHealth } from '@/lib/analytics/health';
import {
  parseTrafficRange,
  trafficSeries,
  trafficWindow,
  type TrafficRange,
} from '@/lib/analytics/traffic';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getIngestState, queryTrafficBuckets } from '@/lib/db/analytics';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export const metadata: Metadata = { title: 'Analytics' };

/**
 * Traffic for the selected environment, from the ingest worker's rollups
 * (ADR-0012). The ingest health panel comes first, so an empty chart always
 * says why; the traffic charts follow, over a fixed range (`?range=`).
 */
export default async function AnalyticsPage({ searchParams }: PageProps<'/analytics'>) {
  await requirePermission('gateway:read');
  const range = parseTrafficRange((await searchParams).range);

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
  const traffic = await loadTraffic(target, range, now);

  return (
    <Page environment={target.label}>
      <IngestHealthPanel health={health} configProblems={configProblems} now={now} />
      <TrafficPanel traffic={traffic} />
    </Page>
  );
}

/** The environment's ingest health, and the time it was read (for the "ago" labels). */
async function loadIngestHealth(target: GatewayTarget) {
  let workerInServer = false;
  let configProblems: readonly string[] = [];
  try {
    workerInServer = parseIngestConfig(process.env).inServer;
  } catch (error) {
    if (!(error instanceof IngestConfigError)) throw error;
    configProblems = error.problems;
  }
  const redisConfigured = target.redisUrl !== null;
  const state = redisConfigured
    ? await getIngestState(getDatabase(), getOrgId(), target.id)
    : undefined;
  const health = ingestHealth({ redisConfigured, workerInServer, state });
  return { health, configProblems, now: Date.now() };
}

/** The range's chart series: every API's totals, summed per step. */
async function loadTraffic(target: GatewayTarget, range: TrafficRange, now: number) {
  const { from, to } = trafficWindow(range, now);
  const buckets = await queryTrafficBuckets(getDatabase(), getOrgId(), {
    environment: target.id,
    bucketSeconds: range.sourceSeconds,
    from,
    to,
  });
  return trafficSeries(range, buckets, now);
}

function Page({ children, environment }: { children: React.ReactNode; environment?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted">
          Traffic, errors and latency
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
