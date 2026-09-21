import 'server-only';

import { findUserByEmail, findUserById, type DataHandle, type User } from '@/lib/db/users';
import { verifyAgainstDummy, verifyPassword } from './password';
import { checkThrottle, noteFailure, noteSuccess, throttleKeys } from './throttle';

/**
 * The account checks behind sign-in and every authenticated request, kept free
 * of Auth.js so they are tested directly against a real database.
 */

export type SignInResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'invalid' | 'disabled' }
  | { ok: false; reason: 'throttled'; kind: 'email' | 'client' };

/**
 * Checks an email and password. `invalid` covers both an unknown email and a
 * wrong password, and costs the same scrypt work either way, so neither the
 * answer nor its timing reveals which emails have accounts. `disabled` is only
 * reported once the password is proven correct.
 */
export async function checkCredentials(
  handle: DataHandle,
  orgId: string,
  email: string,
  password: string,
): Promise<Exclude<SignInResult, { reason: 'throttled' }>> {
  const user = await findUserByEmail(handle, orgId, email);
  if (user === undefined) {
    await verifyAgainstDummy(password);
    return { ok: false, reason: 'invalid' };
  }
  if (!(await verifyPassword(password, user.passwordHash))) return { ok: false, reason: 'invalid' };
  if (user.disabled) return { ok: false, reason: 'disabled' };
  return { ok: true, user };
}

/**
 * A sign-in attempt with throttling (`throttle.ts`) around
 * {@link checkCredentials}: refused before any password work once the email or
 * the client has too many recent failures; a wrong password counts against
 * both; a right one clears the email's count. `client` is the caller's address,
 * or `null` when there is none.
 */
export async function attemptSignIn(
  handle: DataHandle,
  orgId: string,
  { email, password, client }: { email: string; password: string; client: string | null },
): Promise<SignInResult> {
  const keys = throttleKeys(email, client);
  const verdict = await checkThrottle(handle, orgId, keys);
  if (verdict.throttled) return { ok: false, reason: 'throttled', kind: verdict.kind };
  const result = await checkCredentials(handle, orgId, email, password);
  if (result.ok) await noteSuccess(handle, orgId, email);
  else if (result.reason === 'invalid') await noteFailure(handle, orgId, keys);
  return result;
}

/**
 * The account behind a session, re-read from the database on every request
 * (ADR-0004): a user disabled or deleted mid-session loses access on their next
 * request, not when their token expires. So does a session signed in before the
 * account's password last changed (§9): `signedInAt` is stamped into the token
 * at sign-in, and a token without one predates the stamp. `null` means "treat
 * as signed out".
 */
export async function resolveSessionUser(
  handle: DataHandle,
  orgId: string,
  session: { userId?: string | null; orgId?: string | null; signedInAt?: number | null } | null,
): Promise<User | null> {
  if (!session?.userId || session.orgId !== orgId) return null;
  const user = await findUserById(handle, orgId, session.userId);
  if (user === undefined || user.disabled) return null;
  if (
    user.passwordChangedAt !== null &&
    (session.signedInAt ?? 0) < user.passwordChangedAt.getTime()
  ) {
    return null;
  }
  return user;
}
