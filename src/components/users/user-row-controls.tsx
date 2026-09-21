'use client';

import { useActionState } from 'react';
import type { Role } from '@/lib/auth/rbac';
import { INITIAL_USER_FORM_STATE, type UserFormState } from '@/lib/users/forms';
import { RoleSelect } from './controls';

type Props = {
  userId: string;
  email: string;
  role: Role;
  disabled: boolean;
  /** Roles the signed-in user may grant; always includes `role` (the server re-checks). */
  roles: readonly Role[];
  /** `updateUserAction`, passed in by the page so this module imports nothing server-side. */
  action: (previous: UserFormState, formData: FormData) => Promise<UserFormState>;
};

const BUTTON =
  'rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-subtle disabled:opacity-60';

/**
 * Change-role and enable/disable controls for one account row. Both forms share
 * one action state, so the row shows the result of whichever was submitted
 * last: a success on one form replaces an error left by the other.
 */
export function UserRowControls({ userId, email, role, disabled, roles, action }: Props) {
  const [state, formAction, pending] = useActionState(action, INITIAL_USER_FORM_STATE);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="userId" value={userId} />
          <RoleSelect
            name="role"
            roles={roles}
            defaultValue={role}
            aria-label={`Role for ${email}`}
            key={role}
          />
          <button type="submit" disabled={pending} className={BUTTON}>
            Change role
          </button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="disabled" value={disabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className={`${BUTTON} ${disabled ? '' : 'text-danger'}`}
          >
            {disabled ? 'Enable' : 'Disable'}
          </button>
        </form>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : (
        state.notice && (
          <p role="status" className="text-xs text-success">
            {state.notice}
          </p>
        )
      )}
    </div>
  );
}
