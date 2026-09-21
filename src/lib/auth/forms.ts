/**
 * Validation and state for the `/login` and `/setup` forms. Universal (no
 * `server-only`), so the client forms can share the types; the checks run in the
 * server actions, which never trust the browser's own validation. Must stay free
 * of Node-only imports: the login and setup forms bundle it.
 */

/** Shortest password `/setup` (and later, user management) accepts. */
export const MIN_PASSWORD_LENGTH = 12;

/** What a form action returns: the error to show, and the fields to refill. */
export type FormState = {
  error: string | null;
  email?: string;
  name?: string;
};

export const INITIAL_FORM_STATE: FormState = { error: null };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** What is wrong with a new password and its confirmation, or `null` if nothing. */
export function passwordProblem(password: string, confirm: string): string | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return 'The passwords do not match.';
  return null;
}

export type SetupInput = { email: string; name: string; password: string };

export function parseSetupForm(
  formData: FormData,
): { ok: true; value: SetupInput } | { ok: false; state: FormState } {
  const email = field(formData, 'email').trim();
  const name = field(formData, 'name').trim();
  const password = field(formData, 'password');
  const confirm = field(formData, 'confirm');
  const fail = (error: string) => ({ ok: false as const, state: { error, email, name } });

  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  if (name === '') return fail('Enter a name.');
  const problem = passwordProblem(password, confirm);
  if (problem !== null) return fail(problem);
  return { ok: true, value: { email, name, password } };
}

export function parseLoginForm(formData: FormData): { email: string; password: string } {
  return { email: field(formData, 'email').trim(), password: field(formData, 'password') };
}

export type PasswordChangeInput = { current: string; password: string };

/** `/account`'s form: the current password, and the new one twice. */
export function parsePasswordChangeForm(
  formData: FormData,
): { ok: true; value: PasswordChangeInput } | { ok: false; state: FormState } {
  const current = field(formData, 'current');
  const password = field(formData, 'password');
  if (current === '') return { ok: false, state: { error: 'Enter your current password.' } };
  const problem = passwordProblem(password, field(formData, 'confirm'));
  if (problem !== null) return { ok: false, state: { error: problem } };
  return { ok: true, value: { current, password } };
}
