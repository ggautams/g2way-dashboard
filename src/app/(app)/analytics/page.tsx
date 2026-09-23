import type { Metadata } from 'next';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { IngestConfigError, parseIngestConfig } from '@/lib/analytics/config';
import { ingestHealth } from '@/lib/analytics/health';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getIngestState } from '@/lib/db/analytics';
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
 * says why. The traffic charts themselves are the next M6 task.
 */
export default async function AnalyticsPage() {
  await requirePermission('gateway:read');

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

  return (
    <Page environment={target.label}>
      <IngestHealthPanel health={health} configProblems={configProblems} now={now} />
      <section aria-labelledby="traffic-heading" className="flex flex-col gap-3">
        <h2 id="traffic-heading" className="text-lg font-semibold">
          Traffic
        </h2>
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted">
          Requests per second, error rate and latency percentiles land here next (M6).
        </p>
      </section>
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
