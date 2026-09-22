import type { Metadata } from 'next';
import Link from 'next/link';
import { KeyDesigner } from '@/components/keys/key-designer';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { accessFieldHelp } from '@/lib/designer/access-help';
import { loadApiChoices } from '@/lib/g2/apis';
import { listEnvironments } from '@/lib/g2/environments';
import { loadPolicyChoices } from '@/lib/g2/keys';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { keyFieldHelp } from '@/lib/keys/field-help';
import { keySchema } from '@/lib/keys/schema';
import { newKeyDraft } from '@/lib/keys/session';

export const metadata: Metadata = { title: 'New key' };

/** A new key's session. The gateway mints the key itself and returns it once. */
export default async function NewKeyPage() {
  const user = await requirePermission('keys:write');
  const id = await selectedEnvironmentId();
  const label = listEnvironments().find((env) => env.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted">
          <Link href="/keys" className="hover:underline">
            Keys
          </Link>{' '}
          /
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New key</h1>
      </header>
      <KeyDesigner
        stored={null}
        initial={newKeyDraft()}
        help={keyFieldHelp()}
        schema={keySchema()}
        policies={await loadPolicyChoices(id)}
        canWrite
        environment={{ id, label }}
        apis={
          can(user.role, 'apis:read')
            ? await loadApiChoices(id)
            : { ok: false, error: 'Your role cannot read API definitions.' }
        }
        accessHelp={accessFieldHelp('KeySession')}
      />
    </div>
  );
}
