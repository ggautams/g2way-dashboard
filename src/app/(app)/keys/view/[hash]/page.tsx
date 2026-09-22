import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeleteButton } from '@/components/designer/save-bar';
import { RevokeButton, RotateButton } from '@/components/keys/key-actions';
import { KeyDesigner } from '@/components/keys/key-designer';
import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import type { ApiChoices } from '@/lib/designer/access';
import { accessFieldHelp } from '@/lib/designer/access-help';
import { loadApiChoices } from '@/lib/g2/apis';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  listEnvironments,
} from '@/lib/g2/environments';
import { loadKey, loadPolicyChoices, type KeyItem, type PolicyChoices } from '@/lib/g2/keys';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { keyFieldHelp } from '@/lib/keys/field-help';
import { keySchema } from '@/lib/keys/schema';
import { shortHash } from '@/lib/keys/session';

export async function generateMetadata({
  params,
}: PageProps<'/keys/view/[hash]'>): Promise<Metadata> {
  return { title: `Key ${shortHash(decodeURIComponent((await params).hash))}` };
}

/**
 * One key's session, by hash, in the designer: editable with `keys:write`
 * (plus soft revoke, rotate and delete), read-only otherwise. A gateway failure
 * is quoted verbatim; a 404 is the not-found page.
 */
export default async function KeyPage({ params, searchParams }: PageProps<'/keys/view/[hash]'>) {
  const user = await requirePermission('keys:read');
  const hash = decodeURIComponent((await params).hash);
  const query = await searchParams;
  let session: KeyItem['session'];
  let policies: PolicyChoices = { ok: false, error: 'not loaded' };
  let apis: ApiChoices = { ok: false, error: 'not loaded' };
  let environment = { id: '', label: '' };
  try {
    const selected = await selectedEnvironmentId();
    const item = await loadKey(selected, hash);
    session = item.session;
    environment = {
      id: item.environment,
      label:
        listEnvironments().find((env) => env.id === item.environment)?.label ?? item.environment,
    };
    if (session.ok) {
      policies = await loadPolicyChoices(item.environment);
      apis = can(user.role, 'apis:read')
        ? await loadApiChoices(item.environment)
        : { ok: false, error: 'Your role cannot read API definitions.' };
    }
  } catch (error) {
    if (!(error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError)) {
      throw error;
    }
    session = { ok: false, error: error.message };
  }
  if (!session.ok && session.status === 404) notFound();
  const canWrite = can(user.role, 'keys:write');
  const alias = session.ok ? (session.value.alias ?? null) : null;
  const active = session.ok ? (session.value.active ?? true) : true;
  const old = typeof query.old === 'string' ? query.old : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link href="/keys" className="hover:underline">
              Keys
            </Link>{' '}
            / <span className="font-mono">{shortHash(hash)}</span>
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {alias ?? 'Key'}
            {session.ok && !active && <Badge variant="secondary">revoked</Badge>}
          </h1>
          <p className="mt-1 font-mono text-xs break-all text-muted">{hash}</p>
        </div>
        {session.ok && canWrite && (
          <div className="flex flex-wrap gap-2">
            <RevokeButton hash={hash} active={active} environment={environment} />
            <RotateButton hash={hash} environment={environment} />
            <DeleteButton
              kind="key"
              id={hash}
              name={alias ?? `key ${shortHash(hash)}`}
              environment={environment}
            />
          </div>
        )}
      </header>
      {query.saved === '1' && <Notice message={`Saved to ${environment.label}; live now.`} />}
      {query.created === '1' && (
        <Notice message="Key created and live. Its raw value is not shown again." />
      )}
      {query.rotated === '1' && (
        <Notice message="Key rotated: this is the new key, and the old one is deleted." />
      )}
      {query.rotated === 'partial' && (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="font-medium text-danger">Both keys exist</p>
          <p>
            This is the new key, but the old key{' '}
            {old === null ? (
              'could not be deleted'
            ) : (
              <>
                <Link
                  href={`/keys/view/${encodeURIComponent(old)}`}
                  className="font-mono break-all underline"
                >
                  {old}
                </Link>{' '}
                could not be deleted
              </>
            )}{' '}
            and still works. Delete it once its clients have moved.
          </p>
        </section>
      )}
      {session.ok ? (
        <KeyDesigner
          // A save refreshes the page with the stored session: start a fresh draft.
          key={JSON.stringify(session.value)}
          stored={{ hash, session: session.value }}
          initial={session.value}
          help={keyFieldHelp()}
          schema={keySchema()}
          policies={policies}
          canWrite={canWrite}
          environment={environment}
          apis={apis}
          accessHelp={accessFieldHelp('KeySession')}
        />
      ) : (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="mb-1 font-medium text-danger">GET /g2/keys/{shortHash(hash)} failed</p>
          <p className="font-mono text-xs break-all">
            {session.error}
            {session.status !== undefined && ` (HTTP ${session.status})`}
          </p>
        </section>
      )}
    </div>
  );
}
