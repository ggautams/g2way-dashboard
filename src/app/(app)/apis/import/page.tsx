import type { Metadata } from 'next';
import Link from 'next/link';
import { ImportFlow } from '@/components/apis/import-flow';
import { slotExplanations } from '@/components/apis/slot-explain';
import { apiHelp } from '@/lib/apis/field-help';
import { apiDefinitionSchema } from '@/lib/apis/schema';
import { requirePermission } from '@/lib/auth/session';
import { listEnvironments } from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

export const metadata: Metadata = { title: 'Import OpenAPI' };

export default async function ImportApiPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">Import an OpenAPI document</h1>
        <p className="mt-1 text-sm text-muted">
          Start an API definition from an OpenAPI 3.x or Swagger 2.0 description of the upstream.
        </p>
      </header>
      <ImportFlow
        help={apiHelp()}
        explain={slotExplanations()}
        schema={apiDefinitionSchema()}
        environment={{ id, label }}
      />
    </div>
  );
}
