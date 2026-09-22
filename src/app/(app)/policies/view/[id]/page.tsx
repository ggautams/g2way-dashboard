import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeleteButton, NotLiveNote } from '@/components/designer/save-bar';
import { PolicyDesigner } from '@/components/policies/policy-designer';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
} from '@/lib/g2/environments';
import { loadPolicy, type PolicyItem } from '@/lib/g2/policies';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { policyFieldHelp } from '@/lib/policies/field-help';
import { policySchema } from '@/lib/policies/schema';

export async function generateMetadata({
  params,
}: PageProps<'/policies/view/[id]'>): Promise<Metadata> {
  return { title: `Policy ${decodeURIComponent((await params).id)}` };
}

/**
 * One stored policy in the designer: editable with `policies:write`, read-only
 * otherwise. A gateway failure is quoted verbatim; a 404 is the not-found page.
 */
export default async function PolicyPage({
  params,
  searchParams,
}: PageProps<'/policies/view/[id]'>) {
  const user = await requirePermission('policies:read');
  const id = decodeURIComponent((await params).id);
  const { saved } = await searchParams;
  let policy: PolicyItem['policy'];
  let environment = { id: '', label: '' };
  try {
    const item = await loadPolicy(await selectedEnvironmentId(), id);
    policy = item.policy;
    environment = {
      id: item.environment,
      label:
        listEnvironments().find((env) => env.id === item.environment)?.label ?? item.environment,
    };
  } catch (error) {
    if (!(error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError)) {
      throw error;
    }
    policy = { ok: false, error: error.message };
  }
  if (!policy.ok && policy.status === 404) notFound();
  const canWrite = can(user.role, 'policies:write');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link href="/policies" className="hover:underline">
              Policies
            </Link>{' '}
            / <span className="font-mono">{id}</span>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {policy.ok ? policy.value.name : id}
          </h1>
        </div>
        {policy.ok && canWrite && (
          <DeleteButton kind="policy" id={id} name={policy.value.name} environment={environment} />
        )}
      </header>
      {saved === '1' && (
        <div className="flex flex-col gap-1">
          <Notice message={`Saved to ${environment.label}.`} />
          <NotLiveNote kind="policy" environment={environment} />
        </div>
      )}
      {policy.ok ? (
        <PolicyDesigner
          // A save refreshes the page with the new stored policy: start a fresh draft.
          key={JSON.stringify(policy.value)}
          environment={environment}
          original={policy.value}
          initial={policy.value}
          help={policyFieldHelp()}
          schema={policySchema()}
          canWrite={canWrite}
        />
      ) : (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="mb-1 font-medium text-danger">GET /g2/policies/{id} failed</p>
          <p className="font-mono text-xs break-all">
            {policy.error}
            {policy.status !== undefined && ` (HTTP ${policy.status})`}
          </p>
        </section>
      )}
    </div>
  );
}
