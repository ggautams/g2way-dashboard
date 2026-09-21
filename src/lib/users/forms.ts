/**
 * Validation and state for the users page forms. Universal (no `server-only`),
 * so the client forms share the types; the checks run in the server actions
 * (`./actions`), which never trust the browser's own validation.
 */

import { isRole, type Role } from '@/lib/auth/rbac';
import { parseSetupForm, type FormState } from '@/lib/auth/forms';

/** A form's result: an error to show, or a notice after success. */
export type UserFormState = FormState & { notice?: string };

export const INITIAL_USER_FORM_STATE: UserFormState = { error: null };

export type CreateUserInput = { email: string; name: string; password: string; role: Role };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** The create-user form: `/setup`'s fields (same password rules) plus a role. */
export function parseCreateUserForm(
  formData: FormData,
): { ok: true; value: CreateUserInput } | { ok: false; state: UserFormState } {
  const parsed = parseSetupForm(formData);
  if (!parsed.ok) return parsed;
  const role = field(formData, 'role');
  if (!isRole(role)) {
    return { ok: false, state: { error: 'Pick a role.', email: parsed.value.email } };
  }
  return { ok: true, value: { ...parsed.value, role } };
}

export type UserChangeInput =
  { userId: string; change: { role: Role } } | { userId: string; change: { disabled: boolean } };

/** The per-row forms: `userId` plus either `role` or `disabled` (`"true"`/`"false"`). */
export function parseUserChangeForm(formData: FormData): UserChangeInput | { error: string } {
  const userId = field(formData, 'userId');
  if (userId === '') return { error: 'No user given.' };
  if (formData.has('role')) {
    const role = field(formData, 'role');
    return isRole(role) ? { userId, change: { role } } : { error: 'Pick a role.' };
  }
  const disabled = field(formData, 'disabled');
  if (disabled === 'true' || disabled === 'false') {
    return { userId, change: { disabled: disabled === 'true' } };
  }
  return { error: 'Nothing to change.' };
}
