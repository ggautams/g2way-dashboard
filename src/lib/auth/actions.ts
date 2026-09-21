'use server';

import { AuthError, CredentialsSignin } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn, signOut } from '@/auth';
import { getDatabase } from '@/lib/db';
import { recordSignOut } from './audit';
import { recordAudit } from '@/lib/db/audit';
import { changeOwnPassword, createFirstOwner, hasUsers } from '@/lib/db/users';
import { getOrgId } from '@/lib/g2/environments';
import { parseLoginForm, parsePasswordChangeForm, parseSetupForm, type FormState } from './forms';
import { hashPassword, verifyPassword } from './password';
import { checkThrottle, noteFailure, noteSuccess, throttleKeys } from './throttle';
import { getCurrentUser } from './session';

/**
 * Server actions behind `/login`, `/setup` and the shell's sign-out button.
 * Next.js checks each action's `Origin` against the host, so these are not
 * cross-site forgeable. Pages hand them to the client forms as props, so no
 * client module imports this file (`client-boundary.test.ts`).
 */

/** What each `CredentialsSignin` code from `authorize` (`src/auth.ts`) tells the user. */
const SIGN_IN_ERRORS: Record<string, string> = {
  credentials: 'Invalid email or password.',
  disabled: 'This account is disabled.',
  throttled: 'Too many failed sign-in attempts. Wait a few minutes and try again.',
};

async function signInOrExplain(
  email: string,
  password: string,
  redirectTo = '/',
): Promise<FormState> {
  try {
    // Throws Next's redirect on success, which must propagate.
    await signIn('credentials', { email, password, redirectTo });
  } catch (error) {
    if (error instanceof CredentialsSignin) {
      return { error: SIGN_IN_ERRORS[error.code] ?? SIGN_IN_ERRORS.credentials, email };
    }
    if (error instanceof AuthError) return { error: error.message, email };
    throw error;
  }
  return { error: null };
}

export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { email, password } = parseLoginForm(formData);
  if (email === '' || password === '') {
    return { error: 'Enter your email and password.', email };
  }
  return signInOrExplain(email, password);
}

/**
 * First-run bootstrap (audited as `auth.bootstrap` inside `createFirstOwner`'s
 * transaction). The page only renders while the org has no users, but
 * that check is advisory: `createFirstOwner` re-checks inside its transaction,
 * so of two racing submits exactly one becomes owner and the other is sent to
 * `/login`.
 */
export async function setupAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const orgId = getOrgId();
  const database = getDatabase();
  if (await hasUsers(database, orgId)) redirect('/login');

  const parsed = parseSetupForm(formData);
  if (!parsed.ok) return parsed.state;
  const { email, name, password } = parsed.value;

  const owner = await createFirstOwner(database, orgId, {
    email,
    name,
    passwordHash: await hashPassword(password),
  });
  if (owner === null) redirect('/login');
  return signInOrExplain(owner.email, password);
}

export async function signOutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user !== null) await recordSignOut(getDatabase(), getOrgId(), user);
  await signOut({ redirectTo: '/login' });
}

/**
 * `/account`: the signed-in user changes their own password. The current
 * password is checked first, under the same per-email throttle as sign-in (a
 * borrowed session must not become a way to guess the password), and a wrong
 * one is audited as a denied `user.password_change`. The change itself stamps
 * `password_changed_at`, which ends every session of the account signed in
 * before it (ADR-0004 §9), this one included; so the user is signed straight
 * back in with the new password, which also proves it works.
 */
export async function changePasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (user === null) return { error: 'Your session has ended. Sign in again.' };
  const parsed = parsePasswordChangeForm(formData);
  if (!parsed.ok) return parsed.state;
  const { current, password } = parsed.value;
  const orgId = getOrgId();
  const database = getDatabase();

  const keys = throttleKeys(user.email, null);
  if ((await checkThrottle(database, orgId, keys)).throttled) {
    return { error: 'Too many wrong passwords. Wait a few minutes and try again.' };
  }
  if (!(await verifyPassword(current, user.passwordHash))) {
    await noteFailure(database, orgId, keys);
    await recordAudit(database, orgId, {
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'user.password_change',
      target: user.email,
      outcome: 'denied',
      error: 'the current password is wrong',
    });
    return { error: 'The current password is wrong.' };
  }
  await noteSuccess(database, orgId, user.email);

  const result = await changeOwnPassword(database, orgId, user.id, await hashPassword(password));
  if (!result.ok) return { error: 'Your session has ended. Sign in again.' };
  return signInOrExplain(user.email, password, '/account?changed=1');
}
