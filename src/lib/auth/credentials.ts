import 'server-only';

import { findUserByEmail, findUserById, type DataHandle, type User } from '@/lib/db/users';
import { verifyAgainstDummy, verifyPassword } from './password';

/**
 * The account checks behind sign-in and every authenticated request, kept free
 * of Auth.js so they are tested directly against a real database.
 */

export type SignInResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'disabled' };

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
): Promise<SignInResult> {
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
 * The account behind a session, re-read from the database on every request
 * (ADR-0004): a user disabled or deleted mid-session loses access on their next
 * request, not when their token expires. `null` means "treat as signed out".
 */
export async function resolveSessionUser(
  handle: DataHandle,
  orgId: string,
  session: { userId?: string | null; orgId?: string | null } | null,
): Promise<User | null> {
  if (!session?.userId || session.orgId !== orgId) return null;
  const user = await findUserById(handle, orgId, session.userId);
  if (user === undefined || user.disabled) return null;
  return user;
}
