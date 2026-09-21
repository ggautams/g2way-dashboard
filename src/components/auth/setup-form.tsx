'use client';

import { useActionState } from 'react';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/auth/forms';
import { Field, FormError, SubmitButton } from './fields';

type Props = {
  /** `setupAction`, passed in by the page so this module imports nothing server-side. */
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  minPasswordLength: number;
};

export function SetupForm({ action, minPasswordLength }: Props) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="mt-5 flex flex-col gap-3">
      <FormError message={state.error} />
      <Field
        label="Name"
        name="name"
        autoComplete="name"
        required
        autoFocus
        defaultValue={state.name}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        required
        defaultValue={state.email}
      />
      <Field
        label="Password"
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
      <SubmitButton pending={pending}>Create owner and sign in</SubmitButton>
    </form>
  );
}
