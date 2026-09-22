import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiDesigner } from '@/components/apis/api-designer';
import { newDraft } from '@/lib/apis/draft';
import { fieldHelp } from '@/lib/apis/field-help';
import { apiDefinitionSchema } from '@/lib/apis/schema';
import { requirePermission } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'New API' };

export default async function NewApiPage() {
  await requirePermission('apis:write');
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
        help={fieldHelp()}
        schema={apiDefinitionSchema()}
        canWrite
      />
    </div>
  );
}
