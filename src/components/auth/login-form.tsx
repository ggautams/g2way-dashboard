'use client';

import { useActionState } from 'react';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/auth/forms';
import { Field, FormError, SubmitButton } from './fields';

type Props = {
  /** `loginAction`, passed in by the page so this module imports nothing server-side. */
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  initialError: string | null;
};

export function LoginForm({ action, initialError }: Props) {
  const [state, formAction, pending] = useActionState(action, {
    ...INITIAL_FORM_STATE,
    error: initialError,
  });
  return (
    <form action={formAction} className="mt-5 flex flex-col gap-3">
      <FormError message={state.error} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        required
        autoFocus
        defaultValue={state.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <SubmitButton pending={pending}>Sign in</SubmitButton>
    </form>
  );
}
