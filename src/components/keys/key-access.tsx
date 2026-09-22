import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { TypeFields } from '@/lib/designer/access';
import type {
  AccessStatus,
  ApiAccessRow,
  AuthFit,
  DepthRule,
  GraphqlRules,
  KeyAccess,
} from '@/lib/keys/access';
import { describeQuota, describeRate } from '@/lib/policies/list';

/**
 * The key view's Effective access section: what g2way would let this key do,
 * with the policy folded in (`resolveKeyAccess`). A Server Component; it only
 * ever says whether credentials exist, never their values.
 */
export function KeyAccessSection({ access }: { access: KeyAccess }) {
  const { grant, limits } = access;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Effective access</h2>
        <StatusBadge status={access.status} />
      </div>
      {access.reasons.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {access.reasons.map((reason) => (
            <li
              key={reason.code}
              role={reason.effect === 'note' ? undefined : 'alert'}
              className={
                reason.effect === 'denies'
                  ? 'break-words text-danger'
                  : reason.effect === 'unknown'
                    ? 'break-words text-warning'
                    : 'break-words text-muted'
              }
            >
              {reason.text}
            </li>
          ))}
        </ul>
      )}
      {access.status === 'denied' && grant.known && (
        <p className="text-xs text-muted">
          Below is what the key would allow once the denial above is lifted.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Rate limit</dt>
        <dd>{limits.source === 'policy-unavailable' ? 'unknown' : describeRate(limits.rate)}</dd>
        <dt className="text-muted">Quota</dt>
        <dd>{limits.source === 'policy-unavailable' ? 'unknown' : describeQuota(limits.quota)}</dd>
        <dt className="text-muted">From</dt>
        <dd>
          {limits.source === 'key' ? (
            'this key (it applies no policy)'
          ) : (
            <>
              policy{' '}
              <Link
                href={`/policies/view/${encodeURIComponent(limits.policyId)}`}
                className="underline"
              >
                {limits.source === 'policy' ? limits.name : limits.policyId}
              </Link>
              , replacing the key&apos;s own rate, quota and access
            </>
          )}
        </dd>
        <dt className="text-muted">Expires</dt>
        <dd>
          {access.expiresAt === null
            ? 'never'
            : new Date(access.expiresAt * 1000).toISOString().replace('.000Z', 'Z')}
        </dd>
        <dt className="text-muted">Credentials</dt>
        <dd>{credentialText(access.credentials)}</dd>
      </dl>
      {access.ignoredKeyFields.length > 0 && (
        <p className="text-xs text-muted">
          Ignored while the policy applies: the key&apos;s own{' '}
          {access.ignoredKeyFields.map((field) => (
            <code key={field} className="mr-1">
              {field}
            </code>
          ))}
        </p>
      )}
      {grant.known ? (
        <>
          {grant.everyApi && (
            <p className="text-xs text-muted">
              The {grant.source === 'policy' ? 'policy’s' : 'key’s'} <code>access</code> is empty,
              which grants <strong className="text-foreground">every API in the org</strong>. Listed
              below are the APIs <code>GET /g2/apis</code> returns; APIs loaded from{' '}
              <code>--apps-dir</code> files are granted too but are not listed there (
              <code>UPSTREAM.md</code>, &ldquo;<code>GET /g2/apis</code> lists stored definitions
              only&rdquo;).
            </p>
          )}
          {grant.apisError !== null && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              API list unavailable: {grant.apisError}
            </p>
          )}
          {grant.rows.length > 0 && <AccessTable rows={grant.rows} />}
        </>
      ) : (
        <p className="text-xs text-muted">
          Per-API access is unknown: it comes from the applied policy, which could not be read.
        </p>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: AccessStatus }) {
  switch (status) {
    case 'allowed':
      return <Badge variant="outline">allowed</Badge>;
    case 'denied':
      return <Badge variant="destructive">denied</Badge>;
    case 'unknown':
      return <Badge variant="secondary">unknown</Badge>;
  }
}

function credentialText({ basicAuth, hmac }: KeyAccess['credentials']): string {
  const held = [basicAuth && 'basic_auth (password hash)', hmac && 'hmac (shared secret)'].filter(
    (item): item is string => typeof item === 'string',
  );
  return held.length === 0
    ? 'the key only (no basic_auth or hmac data)'
    : `the key, plus ${held.join(' and ')}; values not shown`;
}

function AccessTable({ rows }: { rows: readonly ApiAccessRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 pr-4 font-medium">API</th>
            <th className="py-1 pr-4 font-medium">Auth</th>
            <th className="py-1 font-medium">Restrictions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.apiId} className="border-t border-border align-top">
              <td className="py-2 pr-4">
                {row.api === null ? (
                  <span className="font-mono text-xs">{row.apiId}</span>
                ) : (
                  <Link
                    href={`/apis/view/${encodeURIComponent(row.apiId)}`}
                    className="hover:underline"
                  >
                    {row.api.name}
                  </Link>
                )}
                {row.api !== null && !row.api.active && (
                  <>
                    {' '}
                    <Badge variant="secondary">inactive API</Badge>
                  </>
                )}
              </td>
              <td className="py-2 pr-4 text-xs">
                <AuthCell fit={row.auth} mode={row.api?.authMode ?? null} />
              </td>
              <td className="py-2 text-xs">
                {row.graphql === null ? (
                  <span className="text-muted">none</span>
                ) : (
                  <GraphqlCell rules={row.graphql} ignored={row.graphqlIgnored} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuthCell({ fit, mode }: { fit: AuthFit; mode: string | null }) {
  return (
    <span
      className={fit.kind === 'missing-credentials' ? 'text-danger' : 'text-muted'}
      title={fit.text}
    >
      {mode !== null && <code className="mr-1 text-foreground">{mode}</code>}
      {fit.text}
    </span>
  );
}

const typeList = (list: readonly TypeFields[]) =>
  list.map((type) => `${type.name} (${(type.fields ?? []).join(', ') || 'no fields'})`).join('; ');

function depthText(depth: DepthRule): string | null {
  switch (depth.kind) {
    case 'inherit':
      return null;
    case 'unlimited':
      return 'no depth limit';
    case 'override':
      return `max depth ${depth.depth}`;
  }
}

function GraphqlCell({ rules, ignored }: { rules: GraphqlRules; ignored: boolean }) {
  const depth = depthText(rules.depth);
  return (
    <ul className="flex flex-col gap-0.5">
      {ignored && <li className="text-warning">Ignored: the API is not GraphQL-configured.</li>}
      {rules.allowed.length > 0 && <li>Only: {typeList(rules.allowed)}</li>}
      {rules.restricted.length > 0 && (
        <li className={rules.restrictedIgnored ? 'text-muted line-through' : undefined}>
          Blocked: {typeList(rules.restricted)}
          {rules.restrictedIgnored && ' (ignored: the allow list wins)'}
        </li>
      )}
      {rules.introspectionDisabled && <li>Introspection disabled</li>}
      {depth !== null && <li>{depth}</li>}
    </ul>
  );
}
