'use client';

import { useActionState } from 'react';
import { Field, FormError, SubmitButton } from '@/components/auth/fields';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/auth/forms';

type Props = {
  /** `changePasswordAction`, passed in by the page so this module imports nothing server-side. */
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  minPasswordLength: number;
};

export function ChangePasswordForm({ action, minPasswordLength }: Props) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <FormError message={state.error} />
      <Field
        label="Current password"
        name="current"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={minPasswordLength}
        required
      />
      <Field
        label="Repeat the new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
      />
      <SubmitButton pending={pending}>Change password</SubmitButton>
    </form>
  );
}
