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
  action: FormAction;
  /** `resetPasswordAction`, likewise. */
  resetAction: FormAction;
  minPasswordLength: number;
};

type FormAction = (previous: UserFormState, formData: FormData) => Promise<UserFormState>;

const INPUT =
  'w-48 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-accent';

const BUTTON =
  'rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-subtle disabled:opacity-60';

/**
 * Change-role, enable/disable and reset-password controls for one account row.
 * The forms share one action state, so the row shows the result of whichever
 * was submitted last: a success on one form replaces an error left by another.
 */
export function UserRowControls({
  userId,
  email,
  role,
  disabled,
  roles,
  action,
  resetAction,
  minPasswordLength,
}: Props) {
  const [state, formAction, pending] = useActionState(
    (previous: UserFormState, formData: FormData) =>
      formData.has('password') ? resetAction(previous, formData) : action(previous, formData),
    INITIAL_USER_FORM_STATE,
  );

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
      <details className="text-left">
        <summary className="cursor-pointer text-right text-xs text-muted hover:text-foreground">
          Reset password
        </summary>
        <form action={formAction} className="mt-2 flex flex-col items-end gap-2">
          <input type="hidden" name="userId" value={userId} />
          <input
            type="password"
            name="password"
            required
            minLength={minPasswordLength}
            autoComplete="new-password"
            placeholder="New password"
            aria-label={`New password for ${email}`}
            className={INPUT}
          />
          <input
            type="password"
            name="confirm"
            required
            autoComplete="new-password"
            placeholder="Repeat it"
            aria-label={`Repeat the new password for ${email}`}
            className={INPUT}
          />
          <button type="submit" disabled={pending} className={BUTTON}>
            Set password
          </button>
        </form>
      </details>
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
