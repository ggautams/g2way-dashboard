import type { Metadata } from 'next';
import Link from 'next/link';
import { PolicyDesigner } from '@/components/policies/policy-designer';
import { requirePermission } from '@/lib/auth/session';
import { listEnvironments } from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { newPolicyDraft } from '@/lib/policies/draft';
import { policyFieldHelp } from '@/lib/policies/field-help';
import { policySchema } from '@/lib/policies/schema';

export const metadata: Metadata = { title: 'New policy' };

export default async function NewPolicyPage() {
  await requirePermission('policies:write');
  const id = await selectedEnvironmentId();
  const label = listEnvironments().find((env) => env.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted">
          <Link href="/policies" className="hover:underline">
            Policies
          </Link>{' '}
          /
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New policy</h1>
      </header>
      <PolicyDesigner
        original={null}
        initial={newPolicyDraft()}
        help={policyFieldHelp()}
        schema={policySchema()}
        canWrite
        environment={{ id, label }}
      />
    </div>
  );
}
