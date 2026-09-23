import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeleteButton } from '@/components/designer/save-bar';
import { RevokeButton, RotateButton } from '@/components/keys/key-actions';
import { KeyAccessSection } from '@/components/keys/key-access';
import { KeyDesigner } from '@/components/keys/key-designer';
import { KeyMetadataEditor } from '@/components/keys/key-metadata';
import { KeyUsage } from '@/components/keys/key-usage';
import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/users/controls';
import { can } from '@/lib/auth/rbac';
import { trafficHref } from '@/lib/analytics/drill';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { getKeyMetadata } from '@/lib/db/key-metadata';
import type { ApiChoices } from '@/lib/designer/access';
import { accessFieldHelp } from '@/lib/designer/access-help';
import { loadApiChoices } from '@/lib/g2/apis';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  listEnvironments,
} from '@/lib/g2/environments';
import type { Outcome } from '@/lib/g2/gateway-status';
import { loadKey, loadPolicyChoices, type KeyItem, type PolicyChoices } from '@/lib/g2/keys';
import { loadPolicy } from '@/lib/g2/policies';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { resolveKeyAccess } from '@/lib/keys/access';
import { keyFieldHelp } from '@/lib/keys/field-help';
import type { KeyMetadataFields } from '@/lib/keys/metadata';
import { saveKeyMetadataAction } from '@/lib/keys/metadata-actions';
import { keySchema } from '@/lib/keys/schema';
import { shortHash } from '@/lib/keys/session';
import { effectiveLimits } from '@/lib/keys/usage';
import type { Policy } from '@/lib/policies/list';

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
  // The applied policy, whose rate and quota replace the key's own (Usage panel).
  let applied: Outcome<Policy> | null = null;
  let environment = { id: '', label: '' };
  // When the session was read: the resolver judges expiry against it.
  let nowSecs = 0;
  try {
    const selected = await selectedEnvironmentId();
    const item = await loadKey(selected, hash, user.role);
    session = item.session;
    nowSecs = Math.floor(item.fetchedAt / 1000);
    environment = {
      id: item.environment,
      label:
        listEnvironments().find((env) => env.id === item.environment)?.label ?? item.environment,
    };
    if (session.ok) {
      const policyId = session.value.apply_policies?.[0];
      [policies, applied] = await Promise.all([
        loadPolicyChoices(item.environment),
        policyId === undefined
          ? null
          : loadPolicy(item.environment, policyId, user.role).then((result) => result.policy),
      ]);
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
  // The dashboard's own label, owner and notes (ADR-0009 §7).
  let metadata: { ok: true; value: KeyMetadataFields | null } | { ok: false; error: string } = {
    ok: true,
    value: null,
  };
  if (session.ok) {
    try {
      const row = await getKeyMetadata(getDatabase(), getOrgId(), {
        environment: environment.id,
        keyHash: hash,
      });
      metadata = {
        ok: true,
        value: row === undefined ? null : { label: row.label, owner: row.owner, notes: row.notes },
      };
    } catch (error) {
      metadata = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const label = metadata.ok ? (metadata.value?.label ?? null) : null;
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
            {label ?? alias ?? 'Key'}
            {session.ok && !active && <Badge variant="secondary">revoked</Badge>}
          </h1>
          {label !== null && alias !== null && (
            <p className="text-sm text-muted">
              Alias <span className="text-foreground">{alias}</span>
            </p>
          )}
          <p className="mt-1 font-mono text-xs break-all text-muted">{hash}</p>
          {can(user.role, 'gateway:read') && (
            <p className="mt-1 text-sm">
              <Link href={trafficHref({ key: hash })} className="text-accent hover:underline">
                Traffic for this key
              </Link>
            </p>
          )}
        </div>
        {session.ok && canWrite && (
          <div className="flex flex-wrap gap-2">
            <RevokeButton hash={hash} active={active} environment={environment} />
            <RotateButton hash={hash} environment={environment} />
            <DeleteButton
              kind="key"
              id={hash}
              name={label ?? alias ?? `key ${shortHash(hash)}`}
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
        <Notice message="Key rotated: this is the new key, and the old one is deleted. Any dashboard metadata moved with it." />
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
            and still works. Both carry the same dashboard metadata. Delete the old key once its
            clients have moved.
          </p>
        </section>
      )}
      {session.ok &&
        (metadata.ok ? (
          <KeyMetadataEditor
            hash={hash}
            environment={environment.id}
            stored={metadata.value}
            canWrite={canWrite}
            action={saveKeyMetadataAction}
          />
        ) : (
          <p role="alert" className="font-mono text-xs break-all text-danger">
            Dashboard metadata unavailable: {metadata.error}
          </p>
        ))}
      {session.ok && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <KeyUsage limits={effectiveLimits(session.value, applied)} />
          <KeyAccessSection
            access={resolveKeyAccess({ session: session.value, policy: applied, apis, nowSecs })}
          />
        </div>
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
