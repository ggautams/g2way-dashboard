import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { USAGE_UPSTREAM_ITEM, type EffectiveLimits } from '@/lib/keys/usage';
import { describeQuota, describeRate } from '@/lib/policies/list';

/**
 * The key view's Usage panel: the limits in effect, and a plain statement that
 * live counters are not available. A Server Component; it never shows a
 * number g2way did not give it.
 */
export function KeyUsage({ limits }: { limits: EffectiveLimits }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Usage</h2>
        <p className="text-xs text-muted">{sourceText(limits)}</p>
      </div>
      {limits.source === 'policy-unavailable' ? (
        <p role="alert" className="font-mono text-xs break-all text-danger">
          GET /g2/policies/{limits.policyId} failed: {limits.error}
          {limits.status !== undefined && ` (HTTP ${limits.status})`}
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Rate limit</dt>
          <dd>{describeRate(limits.rate)}</dd>
          <dt className="text-muted">Quota</dt>
          <dd>{describeQuota(limits.quota)}</dd>
        </dl>
      )}
      <p className="text-xs text-muted">
        <strong className="font-medium text-foreground">No live counters.</strong> g2way keeps this
        key&apos;s quota used, remaining and reset time, and its current rate window, in its own
        storage and does not expose them on the admin API yet, so the dashboard cannot show them.
        Tracked in <code>UPSTREAM.md</code> as &ldquo;{USAGE_UPSTREAM_ITEM}&rdquo;
      </p>
    </section>
  );
}

function sourceText(limits: EffectiveLimits) {
  switch (limits.source) {
    case 'key':
      return 'Configured limits in effect: this key’s own (it applies no policy).';
    case 'policy':
      return (
        <>
          Configured limits in effect: from the applied policy{' '}
          <Link
            href={`/policies/view/${encodeURIComponent(limits.policyId)}`}
            className="underline"
          >
            {limits.name}
          </Link>
          {!limits.active && (
            <>
              {' '}
              <Badge variant="secondary">inactive</Badge>
            </>
          )}
          , which replace the key’s own.
        </>
      );
    case 'policy-unavailable':
      return `This key applies policy ${limits.policyId}, whose limits replace the key’s own, but it could not be read.`;
  }
}
