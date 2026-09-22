import { connection } from 'next/server';
import { formatAuditTime } from '@/components/audit/outcome-badge';
import { can, type Role } from '@/lib/auth/rbac';
import { getDatabase } from '@/lib/db';
import { listPendingChanges } from '@/lib/db/pending';
import {
  RegistryConfigError,
  getOrgId,
  getRegistry,
  listEnvironments,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { ReloadButton } from './reload-button';

/**
 * Reload-required, visible everywhere: API and policy writes in the selected
 * environment that are stored but not live, and, for roles that may, the
 * button that makes them live. Streams in after the page, like the degraded
 * banner. Nothing shows while nothing is staged.
 */
export async function PendingChanges({ role }: { role: Role }) {
  await connection();
  let environment: string;
  try {
    environment = await selectedEnvironmentId(undefined, getRegistry());
  } catch (error) {
    if (error instanceof RegistryConfigError) return null;
    throw error;
  }
  const { changes, lastReloadAt } = await listPendingChanges(
    getDatabase(),
    getOrgId(),
    environment,
  );
  if (changes.length === 0) return null;
  const label = listEnvironments().find(({ id }) => id === environment)?.label ?? environment;

  return (
    <div
      role="status"
      className="border-b border-warning/40 bg-warning/5 px-4 py-3 text-sm md:px-8"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-warning">
            {changes.length} saved change{changes.length === 1 ? '' : 's'} in {label}{' '}
            {changes.length === 1 ? 'is' : 'are'} not live yet
          </p>
          <details className="mt-1 text-muted">
            <summary className="cursor-pointer text-xs">
              {lastReloadAt
                ? `Since the last reload from this dashboard, ${formatAuditTime(lastReloadAt)}`
                : 'No reload from this dashboard yet'}{' '}
              — a reload from elsewhere is not seen here.
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
              {changes.map((change) => (
                <li key={change.id}>
                  {change.action} {change.target} · {change.actorEmail ?? 'unknown'} ·{' '}
                  {formatAuditTime(change.createdAt)}
                </li>
              ))}
            </ul>
          </details>
        </div>
        {can(role, 'gateway:reload') ? (
          <ReloadButton environment={environment} />
        ) : (
          <p className="text-xs text-muted">Ask an editor or above to reload the gateway.</p>
        )}
      </div>
    </div>
  );
}
