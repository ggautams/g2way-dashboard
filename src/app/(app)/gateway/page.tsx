import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/gateway/auto-refresh';
import { RouteTable } from '@/components/gateway/route-table';
import { requirePermission } from '@/lib/auth/session';
import { formatDuration } from '@/lib/format';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
  type PublicEnvironment,
} from '@/lib/g2/environments';
import { loadGatewayStatus, type GatewayStatus, type Outcome } from '@/lib/g2/gateway-status';
import { targetsWithHealth, type NodeInfo } from '@/lib/g2/node';

export const metadata: Metadata = { title: 'Gateway' };

export default async function GatewayPage({ searchParams }: PageProps<'/gateway'>) {
  await requirePermission('gateway:read');
  const { env } = await searchParams;
  const requested = typeof env === 'string' ? env : undefined;

  let environments: PublicEnvironment[];
  let status: GatewayStatus;
  try {
    environments = listEnvironments();
    status = await loadGatewayStatus(requested);
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return (
        <Page>
          <Problem title="Cannot pick a gateway">
            <p className="font-mono text-xs">{error.message}</p>
            {error instanceof RegistryConfigError && (
              <ul className="mt-2 list-disc pl-5 font-mono text-xs">
                {error.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </Problem>
        </Page>
      );
    }
    throw error;
  }

  return (
    <Page
      actions={<AutoRefresh />}
      picker={
        environments.length > 1 && (
          <EnvironmentPicker environments={environments} current={status.environment} />
        )
      }
    >
      <Summary status={status} />
      <section aria-labelledby="routes-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="routes-heading" className="text-lg font-semibold">
            Live route table
          </h2>
          {status.node.ok && (
            <p className="text-xs text-muted">
              As routed by node{' '}
              <span className="font-mono">{status.node.value.node_id ?? '(unnamed process)'}</span>{' '}
              — with several replicas each refresh may answer from a different pod.
            </p>
          )}
        </div>
        {status.node.ok ? (
          <RouteTable routes={status.node.value.apis} now={status.fetchedAt} />
        ) : (
          <OutcomeError endpoint="GET /g2/node" outcome={status.node} health={status.health} />
        )}
      </section>
    </Page>
  );
}

function Page({
  children,
  actions,
  picker,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  picker?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gateway</h1>
          <p className="mt-1 text-sm text-muted">
            Node health, version and what it is routing right now.
          </p>
        </div>
        {actions}
      </header>
      {picker}
      {children}
    </div>
  );
}

function EnvironmentPicker({
  environments,
  current,
}: {
  environments: readonly PublicEnvironment[];
  current: string;
}) {
  return (
    <nav aria-label="Environment" className="flex flex-wrap gap-1">
      {environments.map((environment) => {
        const active = environment.id === current;
        return (
          <Link
            key={environment.id}
            href={{ pathname: '/gateway', query: { env: environment.id } }}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md border px-3 py-1 text-sm ${
              active
                ? 'border-accent bg-accent text-accent-foreground'
                : 'border-border hover:bg-subtle'
            }`}
          >
            {environment.label}
          </Link>
        );
      })}
    </nav>
  );
}

function Summary({ status }: { status: GatewayStatus }) {
  const { health, version, node } = status;
  return (
    <section aria-label="Node summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Health">
        {health.ok ? (
          <span className={health.value.status === 'pass' ? 'text-success' : 'text-warning'}>
            {health.value.status}
          </span>
        ) : (
          <CardError outcome={health} />
        )}
      </Card>
      <Card label="Version">
        {version.ok ? (
          <span className="font-mono">{version.value.version}</span>
        ) : (
          <CardError outcome={version} />
        )}
      </Card>
      <Card label="Uptime">
        {node.ok ? formatDuration(node.value.uptime_secs) : <CardError outcome={node} />}
      </Card>
      <Card label="Routes">
        {node.ok ? <Attention node={node.value} /> : <CardError outcome={node} />}
      </Card>
    </section>
  );
}

/** The route count, plus whatever in the table needs a look. */
function Attention({ node }: { node: NodeInfo }) {
  const unhealthy = node.apis
    .flatMap((api) => targetsWithHealth(api))
    .filter((t) => t.healthy === false).length;
  const open = node.apis.filter((api) => api.circuit_breaker === 'open').length;
  const syncErrors = node.apis.filter(
    (api) =>
      api.service_discovery?.last_error != null || api.graphql_schema_sync?.last_error != null,
  ).length;
  const issues = [
    unhealthy > 0 && `${unhealthy} unhealthy target${unhealthy === 1 ? '' : 's'}`,
    open > 0 && `${open} open circuit${open === 1 ? '' : 's'}`,
    syncErrors > 0 && `${syncErrors} sync error${syncErrors === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return (
    <div>
      <span>{node.routes}</span>
      {issues.length > 0 && <p className="mt-1 text-xs text-danger">{issues.join(' · ')}</p>}
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs font-medium text-muted">{label}</h2>
      <div className="mt-1 text-xl font-semibold">{children}</div>
    </article>
  );
}

function CardError({ outcome }: { outcome: Extract<Outcome<unknown>, { ok: false }> }) {
  return (
    <span className="text-sm font-normal text-danger" title={outcome.error}>
      {outcome.status ? `HTTP ${outcome.status}` : 'unavailable'}
    </span>
  );
}

function OutcomeError({
  endpoint,
  outcome,
  health,
}: {
  endpoint: string;
  outcome: Extract<Outcome<unknown>, { ok: false }>;
  health: Outcome<unknown>;
}) {
  return (
    <Problem title={`${endpoint} failed${outcome.status ? ` (HTTP ${outcome.status})` : ''}`}>
      {/* The gateway's message, verbatim. */}
      <p className="font-mono text-xs">{outcome.error}</p>
      {outcome.status === 403 && health.ok && (
        <p className="mt-2 text-muted">
          The gateway is up (its unauthenticated health check passes) but refused this
          environment&apos;s admin secret.
        </p>
      )}
    </Problem>
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
