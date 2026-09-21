import 'server-only';

import { recordAudit, type AuditRecord } from '@/lib/db/audit';
import { normaliseEmail, type DataHandle, type User } from '@/lib/db/users';
import type { SignInResult } from './credentials';

/**
 * Audit rows for sign-in and sign-out (ADR-0006 §5). These are best effort: a
 * failure to write one is logged loudly and does not block signing in or out,
 * because refusing every sign-in while the audit table is unwritable would lock
 * the owners out of the console they need to fix it.
 *
 * A failed sign-in never stores the password, and records the same thing for
 * an unknown email as for a wrong password ("invalid email or password"), so
 * the log does not become a list of which addresses have accounts. The
 * attempted address is kept only when it looks like one: people paste
 * passwords into the email field, and that must not land in the log.
 */

const EMAIL_LIKE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/** What a failed sign-in records as its target: the address tried, or a placeholder. */
export function attemptedEmail(input: string): string {
  const email = normaliseEmail(input);
  return EMAIL_LIKE.test(email) ? email : '[not an email address]';
}

const actorOf = ({ id, email, role }: User) => ({ id, email, role });

async function recordLoudly(handle: DataHandle, orgId: string, record: AuditRecord) {
  try {
    await recordAudit(handle, orgId, record);
  } catch (error) {
    console.error(`[audit] FAILED to record ${record.outcome} ${record.action}:`, error);
  }
}

export async function recordSignIn(
  handle: DataHandle,
  orgId: string,
  email: string,
  result: SignInResult,
): Promise<void> {
  if (result.ok) {
    await recordLoudly(handle, orgId, {
      actor: actorOf(result.user),
      action: 'auth.sign_in',
      target: result.user.email,
      outcome: 'success',
    });
    return;
  }
  if (result.reason === 'throttled') {
    await recordLoudly(handle, orgId, {
      actor: null,
      action: 'auth.sign_in',
      target: attemptedEmail(email),
      outcome: 'denied',
      error: 'too many failed sign-in attempts',
      notes: [`throttled per ${result.kind}; the password was not checked`],
    });
    return;
  }
  await recordLoudly(handle, orgId, {
    actor: null,
    action: 'auth.sign_in',
    target: attemptedEmail(email),
    outcome: result.reason === 'disabled' ? 'denied' : 'failure',
    // `disabled` is only known once the password was proven right (ADR-0004 §7).
    error: result.reason === 'disabled' ? 'the account is disabled' : 'invalid email or password',
  });
}

export async function recordSignOut(handle: DataHandle, orgId: string, user: User): Promise<void> {
  await recordLoudly(handle, orgId, {
    actor: actorOf(user),
    action: 'auth.sign_out',
    target: user.email,
    outcome: 'success',
  });
}
