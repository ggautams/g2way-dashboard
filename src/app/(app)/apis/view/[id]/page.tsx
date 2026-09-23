import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiDesigner } from '@/components/apis/api-designer';
import { slotExplanations } from '@/components/apis/slot-explain';
import { apiHelp } from '@/lib/apis/field-help';
import { apiDefinitionSchema } from '@/lib/apis/schema';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { loadHistory } from '@/lib/designer/load-history';
import { loadApi, type ApiItem } from '@/lib/g2/apis';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  listEnvironments,
  resolveEnvironment,
} from '@/lib/g2/environments';
import { DeleteButton, NotLiveNote } from '@/components/designer/save-bar';
import { Notice } from '@/components/users/controls';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export async function generateMetadata({
  params,
}: PageProps<'/apis/view/[id]'>): Promise<Metadata> {
  return { title: `API ${decodeURIComponent((await params).id)}` };
}

/**
 * One stored definition in the designer: editable with `apis:write`, read-only
 * otherwise. The Console tab sends test requests with `apis:test` (ADR-0011). A gateway failure is quoted verbatim; a 404 is the not-found page.
 */
export default async function ApiPage({ params, searchParams }: PageProps<'/apis/view/[id]'>) {
  const user = await requirePermission('apis:read');
  const id = decodeURIComponent((await params).id);
  const { saved } = await searchParams;
  let api: ApiItem['api'];
  let environment = { id: '', label: '' };
  try {
    const item = await loadApi(await selectedEnvironmentId(), id, user.role);
    api = item.api;
    environment = {
      id: item.environment,
      label:
        listEnvironments().find((env) => env.id === item.environment)?.label ?? item.environment,
    };
  } catch (error) {
    if (!(error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError)) {
      throw error;
    }
    api = { ok: false, error: error.message };
  }
  if (!api.ok && api.status === 404) notFound();
  const canWrite = can(user.role, 'apis:write');
  const history = api.ok
    ? await loadHistory(
        getDatabase(),
        getOrgId(),
        {
          environment: environment.id,
          kind: 'api',
          resourceId: id,
        },
        user.role,
      )
    : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link href="/apis" className="hover:underline">
              APIs
            </Link>{' '}
            / <span className="font-mono">{id}</span>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{api.ok ? api.value.name : id}</h1>
        </div>
        {api.ok && canWrite && (
          <DeleteButton kind="api" id={id} name={api.value.name} environment={environment} />
        )}
      </header>
      {saved === '1' && (
        <div className="flex flex-col gap-1">
          <Notice message={`Saved to ${environment.label}.`} />
          <NotLiveNote kind="api" environment={environment} />
        </div>
      )}
      {api.ok ? (
        <ApiDesigner
          // A save refreshes the page with the new stored definition: start a fresh draft.
          key={JSON.stringify(api.value)}
          environment={environment}
          history={history}
          original={api.value}
          initial={api.value}
          help={apiHelp()}
          explain={slotExplanations()}
          schema={apiDefinitionSchema()}
          canWrite={canWrite}
          console={{
            canSend: can(user.role, 'apis:test'),
            // Only whether a proxy URL is set: the URL itself stays on the server (ADR-0011).
            configured: resolveEnvironment(environment.id).proxyUrl !== null,
          }}
        />
      ) : (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="mb-1 font-medium text-danger">GET /g2/apis/{id} failed</p>
          <p className="font-mono text-xs break-all">
            {api.error}
            {api.status !== undefined && ` (HTTP ${api.status})`}
          </p>
        </section>
      )}
    </div>
  );
}
