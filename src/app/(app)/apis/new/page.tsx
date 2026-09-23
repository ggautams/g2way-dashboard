import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiDesigner } from '@/components/apis/api-designer';
import { slotExplanations } from '@/components/apis/slot-explain';
import { newDraft } from '@/lib/apis/draft';
import { apiHelp } from '@/lib/apis/field-help';
import { apiDefinitionSchema } from '@/lib/apis/schema';
import { requirePermission } from '@/lib/auth/session';
import { listEnvironments } from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export const metadata: Metadata = { title: 'New API' };

export default async function NewApiPage() {
  await requirePermission('apis:write');
  const id = await selectedEnvironmentId();
  const label = listEnvironments().find((env) => env.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted">
          <Link href="/apis" className="hover:underline">
            APIs
          </Link>{' '}
          /
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New API</h1>
      </header>
      <ApiDesigner
        original={null}
        initial={newDraft()}
        help={apiHelp()}
        explain={slotExplanations()}
        schema={apiDefinitionSchema()}
        canWrite
        environment={{ id, label }}
      />
    </div>
  );
}
