import type { AuditOutcome } from '@/lib/db/schema/shared';

const STYLE: Record<AuditOutcome, string> = {
  success: 'text-success',
  failure: 'text-danger',
  denied: 'text-warning',
  pending: 'text-muted',
};

const TITLE: Record<AuditOutcome, string> = {
  success: 'The action went through',
  failure: 'The action was attempted and failed',
  denied: 'Refused before anything changed',
  pending: 'The write was attempted but its result was never recorded',
};

/** An audit row's outcome, coloured. Server Component. */
export function OutcomeBadge({ outcome }: { outcome: AuditOutcome }) {
  return (
    <span className={`font-mono text-xs ${STYLE[outcome]}`} title={TITLE[outcome]}>
      {outcome}
    </span>
  );
}

/** Timestamps are shown in UTC, identically on server and client. */
export function formatAuditTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
