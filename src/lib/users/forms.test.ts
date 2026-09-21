import { describe, expect, it } from 'vitest';
import { parseCreateUserForm, parseUserChangeForm } from './forms';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const valid = {
  email: ' vee@example.com ',
  name: 'Vee',
  password: 'correct horse battery',
  confirm: 'correct horse battery',
  role: 'viewer',
};

describe('parseCreateUserForm', () => {
  it('accepts a valid account with a known role', () => {
    expect(parseCreateUserForm(form(valid))).toEqual({
      ok: true,
      value: { email: 'vee@example.com', name: 'Vee', password: valid.password, role: 'viewer' },
    });
  });

  it('applies the setup form rules, then requires a known role', () => {
    expect(
      parseCreateUserForm(form({ ...valid, password: 'short', confirm: 'short' })),
    ).toMatchObject({ ok: false, state: { error: expect.stringMatching(/at least 12/) } });
    expect(parseCreateUserForm(form({ ...valid, role: 'root' }))).toMatchObject({
      ok: false,
      state: { error: 'Pick a role.', email: 'vee@example.com' },
    });
  });
});

describe('parseUserChangeForm', () => {
  it('reads a role change or an enable/disable', () => {
    expect(parseUserChangeForm(form({ userId: 'u', role: 'editor' }))).toEqual({
      userId: 'u',
      change: { role: 'editor' },
    });
    expect(parseUserChangeForm(form({ userId: 'u', disabled: 'true' }))).toEqual({
      userId: 'u',
      change: { disabled: true },
    });
    expect(parseUserChangeForm(form({ userId: 'u', disabled: 'false' }))).toEqual({
      userId: 'u',
      change: { disabled: false },
    });
  });

  it('rejects anything else', () => {
    expect(parseUserChangeForm(form({ role: 'editor' }))).toEqual({ error: 'No user given.' });
    expect(parseUserChangeForm(form({ userId: 'u', role: 'god' }))).toEqual({
      error: 'Pick a role.',
    });
    expect(parseUserChangeForm(form({ userId: 'u', disabled: 'yes' }))).toEqual({
      error: 'Nothing to change.',
    });
  });
});
