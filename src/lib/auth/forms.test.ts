import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  parseLoginForm,
  parsePasswordChangeForm,
  parseSetupForm,
  passwordProblem,
} from './forms';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const good = {
  email: ' ada@example.com ',
  name: ' Ada ',
  password: 'x'.repeat(MIN_PASSWORD_LENGTH),
  confirm: 'x'.repeat(MIN_PASSWORD_LENGTH),
};

describe('parseSetupForm', () => {
  it('accepts a valid form, trimming email and name but never the password', () => {
    expect(parseSetupForm(form({ ...good, password: ' pw ', confirm: ' pw ' })).ok).toBe(false);
    expect(parseSetupForm(form(good))).toEqual({
      ok: true,
      value: { email: 'ada@example.com', name: 'Ada', password: good.password },
    });
  });

  it.each([
    [{ email: 'not-an-email' }, /email/],
    [{ name: '  ' }, /name/],
    [{ password: 'short', confirm: 'short' }, new RegExp(String(MIN_PASSWORD_LENGTH))],
    [{ confirm: 'y'.repeat(MIN_PASSWORD_LENGTH) }, /do not match/],
  ])('rejects %o and refills email and name, never passwords', (override, message) => {
    const result = parseSetupForm(form({ ...good, ...override }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.error).toMatch(message);
    expect(Object.keys(result.state).sort()).toEqual(['email', 'error', 'name']);
  });

  it('treats missing fields as empty', () => {
    expect(parseSetupForm(new FormData()).ok).toBe(false);
  });
});

describe('parseLoginForm', () => {
  it('trims the email only', () => {
    expect(parseLoginForm(form({ email: ' a@b.c ', password: ' pw ' }))).toEqual({
      email: 'a@b.c',
      password: ' pw ',
    });
    expect(parseLoginForm(new FormData())).toEqual({ email: '', password: '' });
  });
});

describe('passwordProblem', () => {
  const ok = 'x'.repeat(MIN_PASSWORD_LENGTH);
  it('wants the minimum length in characters, and a matching confirmation', () => {
    expect(passwordProblem(ok, ok)).toBeNull();
    expect(
      passwordProblem('é'.repeat(MIN_PASSWORD_LENGTH), 'é'.repeat(MIN_PASSWORD_LENGTH)),
    ).toBeNull();
    expect(passwordProblem(ok.slice(1), ok.slice(1))).toMatch(/at least/);
    expect(passwordProblem(ok, `${ok}!`)).toMatch(/do not match/);
  });
});

describe('parsePasswordChangeForm', () => {
  const next = 'y'.repeat(MIN_PASSWORD_LENGTH);
  it('needs the current password and a valid new one', () => {
    expect(
      parsePasswordChangeForm(form({ current: 'old', password: next, confirm: next })),
    ).toEqual({
      ok: true,
      value: { current: 'old', password: next },
    });
    expect(parsePasswordChangeForm(form({ password: next, confirm: next }))).toMatchObject({
      ok: false,
      state: { error: 'Enter your current password.' },
    });
    expect(
      parsePasswordChangeForm(form({ current: 'old', password: next, confirm: '' })),
    ).toMatchObject({
      ok: false,
      state: { error: 'The passwords do not match.' },
    });
  });
});
