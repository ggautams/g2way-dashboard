'use client';

import { useActionState } from 'react';
import { Field, FormError, SubmitButton } from '@/components/auth/fields';
import type { Role } from '@/lib/auth/rbac';
import { INITIAL_USER_FORM_STATE, type UserFormState } from '@/lib/users/forms';
import { Notice, RoleSelect } from './controls';

type Props = {
  /** `createUserAction`, passed in by the page so this module imports nothing server-side. */
  action: (previous: UserFormState, formData: FormData) => Promise<UserFormState>;
  /** The roles the signed-in user may grant (the server re-checks). */
  roles: readonly Role[];
  minPasswordLength: number;
};

export function CreateUserForm({ action, roles, minPasswordLength }: Props) {
  const [state, formAction, pending] = useActionState(action, INITIAL_USER_FORM_STATE);
  return (
    // Keyed on the notice, so a successful create clears the fields.
    <form key={state.notice} action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FormError message={state.error} />
        <Notice message={state.notice} />
      </div>
      <Field label="Name" name="name" autoComplete="off" required defaultValue={state.name} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="off"
        required
        defaultValue={state.email}
      />
      <Field
        label="Initial password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minPasswordLength}
        required
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={minPasswordLength}
        required
      />
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Role</span>
        <RoleSelect
          name="role"
          roles={roles}
          defaultValue={roles.includes('viewer') ? 'viewer' : roles[0]}
        />
      </label>
      <div className="flex items-end">
        <SubmitButton pending={pending}>Create user</SubmitButton>
      </div>
    </form>
  );
}
