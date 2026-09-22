import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiDesigner } from '@/components/apis/api-designer';
import { fieldHelp } from '@/lib/apis/field-help';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { loadApi, type ApiItem } from '@/lib/g2/apis';
import { RegistryConfigError, UnknownEnvironmentError } from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export async function generateMetadata({ params }: PageProps<'/apis/[id]'>): Promise<Metadata> {
  return { title: `API ${decodeURIComponent((await params).id)}` };
}

/**
 * One stored definition in the designer: editable with `apis:write`, read-only
 * otherwise. A gateway failure is quoted verbatim; a 404 is the not-found page.
 */
export default async function ApiPage({ params }: PageProps<'/apis/[id]'>) {
  const user = await requirePermission('apis:read');
  const id = decodeURIComponent((await params).id);
  let api: ApiItem['api'];
  try {
    ({ api } = await loadApi(await selectedEnvironmentId(), id));
  } catch (error) {
    if (!(error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError)) {
      throw error;
    }
    api = { ok: false, error: error.message };
  }
  if (!api.ok && api.status === 404) notFound();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted">
          <Link href="/apis" className="hover:underline">
            APIs
          </Link>{' '}
          / <span className="font-mono">{id}</span>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{api.ok ? api.value.name : id}</h1>
      </header>
      {api.ok ? (
        <ApiDesigner
          original={api.value}
          initial={api.value}
          help={fieldHelp()}
          canWrite={can(user.role, 'apis:write')}
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
