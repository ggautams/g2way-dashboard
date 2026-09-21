import Link from 'next/link';
import { connection } from 'next/server';
import { probeEnvironments, type Probe } from '@/lib/g2/reachability';
import { RetryButton } from './retry-button';

type Failing = Exclude<Probe, { state: 'ok' }>;

const STATE_TEXT: Record<Failing['state'], string> = {
  unreachable: 'is unreachable',
  refused: 'refused the admin secret',
  error: 'is answering with errors',
};

/**
 * Shown above every page while a configured gateway cannot be managed. The
 * page still renders underneath; this says why its gateway data is missing,
 * quoting the gateway (or the network error) verbatim.
 */
export async function DegradedBanner() {
  // Probes the runtime environment, per request — never at build time.
  await connection();
  const reachability = await probeEnvironments();

  if (reachability.kind === 'misconfigured') {
    return (
      <Banner tone="danger" title="Gateway configuration is invalid">
        <p>
          The dashboard cannot reach any gateway until this is fixed —{' '}
          <Link href="/" className="underline">
            see the Overview
          </Link>{' '}
          for each problem.
        </p>
      </Banner>
    );
  }

  const failing = reachability.probes.filter((probe): probe is Failing => probe.state !== 'ok');
  if (failing.length === 0) return null;
  const unreachable = failing.some((probe) => probe.state === 'unreachable');

  return (
    <Banner
      tone={unreachable ? 'danger' : 'warning'}
      title={
        failing.length === 1
          ? `${failing[0].environment.label} ${STATE_TEXT[failing[0].state]}`
          : `${failing.length} gateways cannot be managed`
      }
    >
      <ul className="flex flex-col gap-1">
        {failing.map((probe) => (
          <li key={probe.environment.id} className="flex flex-wrap items-baseline gap-x-2">
            {failing.length > 1 && (
              <span className="font-medium">
                {probe.environment.label} {STATE_TEXT[probe.state]}:
              </span>
            )}
            <span className="font-mono text-xs break-all">
              {probe.message}
              {probe.state !== 'unreachable' && ` (HTTP ${probe.status})`}
            </span>
            <Link
              href={{ pathname: '/gateway', query: { env: probe.environment.id } }}
              className="text-xs underline"
            >
              details
            </Link>
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning';
  title: string;
  children: React.ReactNode;
}) {
  const colours =
    tone === 'danger' ? 'border-danger/40 bg-danger/5' : 'border-warning/40 bg-warning/5';
  return (
    <div role="alert" className={`border-b px-4 py-3 text-sm md:px-8 ${colours}`}>
      <div className="mx-auto flex w-full max-w-6xl items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`font-medium ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}>
            {title}
          </p>
          <div className="mt-1 text-muted">{children}</div>
        </div>
        <RetryButton />
      </div>
    </div>
  );
}
