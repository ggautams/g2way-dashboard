import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiDesigner } from '@/components/apis/api-designer';
import { fieldHelp } from '@/lib/apis/field-help';
import { apiDefinitionSchema } from '@/lib/apis/schema';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { loadApi, type ApiItem } from '@/lib/g2/apis';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
} from '@/lib/g2/environments';
import { DeleteApiButton, NotLiveNote } from '@/components/apis/save-bar';
import { Notice } from '@/components/users/controls';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export async function generateMetadata({ params }: PageProps<'/apis/[id]'>): Promise<Metadata> {
  return { title: `API ${decodeURIComponent((await params).id)}` };
}

/**
 * One stored definition in the designer: editable with `apis:write`, read-only
 * otherwise. A gateway failure is quoted verbatim; a 404 is the not-found page.
 */
export default async function ApiPage({ params, searchParams }: PageProps<'/apis/[id]'>) {
  const user = await requirePermission('apis:read');
  const id = decodeURIComponent((await params).id);
  const { saved } = await searchParams;
  let api: ApiItem['api'];
  let environment = { id: '', label: '' };
  try {
    const item = await loadApi(await selectedEnvironmentId(), id);
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
          <DeleteApiButton apiId={id} name={api.value.name} environment={environment} />
        )}
      </header>
      {saved === '1' && (
        <div className="flex flex-col gap-1">
          <Notice message={`Saved to ${environment.label}.`} />
          <NotLiveNote environment={environment} />
        </div>
      )}
      {api.ok ? (
        <ApiDesigner
          // A save refreshes the page with the new stored definition: start a fresh draft.
          key={JSON.stringify(api.value)}
          environment={environment}
          original={api.value}
          initial={api.value}
          help={fieldHelp()}
          schema={apiDefinitionSchema()}
          canWrite={canWrite}
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
