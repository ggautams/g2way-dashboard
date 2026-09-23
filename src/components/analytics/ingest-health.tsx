import { formatAge } from '@/lib/format';
import { GATEWAY_RECORD_CAP, type IngestHealth, type IngestStatus } from '@/lib/analytics/health';

/**
 * Ingest health for one environment (ADR-0012 §8), shown on every traffic page
 * so an empty chart always says why. A Server Component: it receives the
 * classified state, never a Redis URL.
 */
export function IngestHealthPanel({
  health,
  configProblems,
  now,
}: {
  health: IngestHealth;
  /** Why this server's worker did not start (`IngestConfigError.problems`), if it did not. */
  configProblems: readonly string[];
  now: number;
}) {
  const { status, backlog, state } = health;
  const tone = TONE[status];
  return (
    <section
      aria-labelledby="ingest-health-heading"
      role={status === 'ok' ? undefined : 'status'}
      className={`rounded-lg border p-4 text-sm ${tone.box}`}
    >
      <h2 id="ingest-health-heading" className={`font-medium ${tone.text}`}>
        Ingest: {TITLE[status]}
      </h2>
      <div className="mt-1 flex flex-col gap-2 text-muted">
        <Explanation health={health} now={now} />
        {backlog?.nearCap && (
          <p className="text-danger">
            Backlog {backlog.count.toLocaleString('en')} of g2way&apos;s{' '}
            {GATEWAY_RECORD_CAP.toLocaleString('en')}-record cap
            {backlog.asOf && ` (${ago(backlog.asOf, now)})`}. The gateway trims the oldest records
            past the cap, so traffic is being lost: add workers, or raise{' '}
            <code className="font-mono">G2_ANALYTICS_BATCH</code>.
          </p>
        )}
        {configProblems.length > 0 && (
          <div>
            <p className="text-danger">This server&apos;s ingest worker did not start:</p>
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {configProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {state && status !== 'not-configured' && <Counters state={state} now={now} />}
      </div>
    </section>
  );
}

const TITLE: Record<IngestStatus, string> = {
  'not-configured': 'no Redis configured',
  failing: 'worker failing',
  'not-sending': 'no records received',
  ok: 'receiving records',
};

const TONE: Record<IngestStatus, { box: string; text: string }> = {
  'not-configured': { box: 'border-border bg-surface', text: 'text-foreground' },
  failing: { box: 'border-danger/40 bg-danger/5', text: 'text-danger' },
  'not-sending': { box: 'border-warning/40 bg-warning/5', text: 'text-warning' },
  ok: { box: 'border-border bg-surface', text: 'text-success' },
};

function ago(date: Date, now: number): string {
  return formatAge(Math.floor(date.getTime() / 1000), now);
}

function Explanation({ health, now }: { health: IngestHealth; now: number }) {
  const { status, state, workerInServer } = health;
  switch (status) {
    case 'not-configured':
      return (
        <p>
          This environment names no Redis, so the dashboard has no analytics for it. Set{' '}
          <code className="font-mono">G2_REDIS_URL</code> (or{' '}
          <code className="font-mono">G2_ENV_&lt;ID&gt;_REDIS_URL</code>) to the Redis the gateway
          writes to, and run the gateway with{' '}
          <code className="font-mono">--analytics-sink redis</code>.
        </p>
      );
    case 'failing':
      return (
        <>
          <p>
            The worker&apos;s last error
            {state?.lastErrorAt && ` (${ago(state.lastErrorAt, now)})`} is newer than its last
            successful drain
            {state?.lastDrainedAt
              ? ` (${ago(state.lastDrainedAt, now)})`
              : ', which never happened'}
            . Records wait in Redis until it recovers, up to the gateway&apos;s cap.
          </p>
          {state?.lastError && (
            <p className="font-mono text-xs break-all text-foreground">{state.lastError}</p>
          )}
          <p className="text-xs">
            With no traffic, a recovered worker pops nothing and this stays until the next record
            arrives.
          </p>
        </>
      );
    case 'not-sending':
      return (
        <p>
          No worker has popped a record for this environment yet. Either the gateway is not sending
          (it must run with <code className="font-mono">--analytics-sink redis</code>, i.e.{' '}
          <code className="font-mono">G2_ANALYTICS_SINK=redis</code>, against this Redis) or it has
          served no traffic
          {workerInServer ? (
            '.'
          ) : (
            <>
              , or no worker runs: this server&apos;s is off (
              <code className="font-mono">G2_ANALYTICS_INGEST=off</code>), so{' '}
              <code className="font-mono">npm run ingest</code> must run elsewhere.
            </>
          )}
        </p>
      );
    case 'ok':
      return (
        <p>
          Last drain {state?.lastDrainedAt ? ago(state.lastDrainedAt, now) : 'unknown'}
          {state?.lastRecordAt && `, newest record ${ago(state.lastRecordAt, now)}`}.
        </p>
      );
  }
}

function Counters({ state, now }: { state: NonNullable<IngestHealth['state']>; now: number }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      <Counter label="Records ingested" value={state.recordsIngested.toLocaleString('en')} />
      <Counter label="Rejected" value={state.recordsRejected.toLocaleString('en')} />
      <Counter label="Batches" value={state.batches.toLocaleString('en')} />
      <Counter
        label="Backlog"
        value={`${state.backlog.toLocaleString('en')}${state.lastDrainedAt ? ` (${ago(state.lastDrainedAt, now)})` : ''}`}
      />
      {state.lastRejection && (
        <div className="col-span-full">
          <dt className="inline text-muted">Last rejection: </dt>
          <dd className="inline font-mono break-all text-foreground">{state.lastRejection}</dd>
        </div>
      )}
    </dl>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}
