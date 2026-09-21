'use server';

import { revalidatePath } from 'next/cache';
import { hashPassword } from '@/lib/auth/password';
import { can } from '@/lib/auth/rbac';
import { getCurrentUser } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { createUser, updateUser, type User, type UserWriteRefusal } from '@/lib/db/users';
import { getOrgId } from '@/lib/g2/environments';
import { parseCreateUserForm, parseUserChangeForm, type UserFormState } from './forms';

/**
 * Server actions behind the users page. Each one re-checks the caller's
 * session and `users:manage` itself (a server action is a public endpoint,
 * whatever page rendered it), then the data layer re-checks everything else —
 * who may change whom, and the last-owner invariant — inside its transaction.
 *
 * Every write, and every refusal, is audited by the data layer inside the same
 * transaction (ADR-0006), with the account before and after it.
 */

async function manager(): Promise<User | UserFormState> {
  const actor = await getCurrentUser();
  if (actor === null) return { error: 'Your session has ended. Sign in again.' };
  if (!can(actor.role, 'users:manage')) {
    return { error: `Forbidden: the ${actor.role} role lacks the users:manage permission.` };
  }
  return actor;
}

function isState(value: User | UserFormState): value is UserFormState {
  return 'error' in value;
}

/** A data-layer refusal as form state: its message, shown as the data layer wrote it. */
function refused({ message }: UserWriteRefusal, refill: UserFormState = { error: null }) {
  return { ...refill, error: `${message[0].toUpperCase()}${message.slice(1)}.` };
}

export async function createUserAction(
  _previous: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const actor = await manager();
  if (isState(actor)) return actor;
  const parsed = parseCreateUserForm(formData);
  if (!parsed.ok) return parsed.state;
  const { email, name, password, role } = parsed.value;

  const result = await createUser(getDatabase(), getOrgId(), actor.id, {
    email,
    name,
    role,
    passwordHash: await hashPassword(password),
  });
  if (!result.ok) return refused(result, { error: null, email, name });
  revalidatePath('/users');
  return { error: null, notice: `Created ${result.after.email} as ${result.after.role}.` };
}

export async function updateUserAction(
  _previous: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const actor = await manager();
  if (isState(actor)) return actor;
  const parsed = parseUserChangeForm(formData);
  if ('error' in parsed) return { error: parsed.error };

  const result = await updateUser(
    getDatabase(),
    getOrgId(),
    actor.id,
    parsed.userId,
    parsed.change,
  );
  if (!result.ok) return refused(result);
  revalidatePath('/users');
  const { after } = result;
  return {
    error: null,
    notice:
      'role' in parsed.change
        ? `${after.email} is now ${after.role}.`
        : `${after.email} is ${after.disabled ? 'disabled' : 'enabled'}.`,
  };
}
