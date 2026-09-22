import { describe, expect, it } from 'vitest';
import {
  grantsEveryApi,
  isPolicyShape,
  newPolicyDraft,
  otherPolicyFields,
  parseLimit,
  policyProblems,
  withPolicyField,
} from './draft';
import type { Policy } from './list';

const gold: Policy = {
  policy_id: 'gold',
  name: 'Gold',
  org_id: 'org-under-test',
  rate: { requests: 100, per_seconds: 60 },
  access: { orders: { disable_introspection: true } },
};

describe('the draft', () => {
  it('starts with the required fields empty and active', () => {
    expect(newPolicyDraft()).toEqual({ policy_id: '', name: '', active: true });
    expect(grantsEveryApi(newPolicyDraft())).toBe(true);
  });

  it('sets and removes fields without touching access', () => {
    const off = withPolicyField(gold, 'rate', undefined);
    expect(off).not.toHaveProperty('rate');
    expect(off.access).toBe(gold.access);
    expect(withPolicyField(gold, 'quota', { max: 5, renewal_rate_secs: 60 }).quota).toEqual({
      max: 5,
      renewal_rate_secs: 60,
    });
    expect(gold).toHaveProperty('rate');
  });

  it('lists what only the raw view edits, never org_id', () => {
    expect(otherPolicyFields(gold)).toEqual(['access']);
    expect(grantsEveryApi(gold)).toBe(false);
    expect(grantsEveryApi({ ...gold, access: {} })).toBe(true);
  });
});

describe('parseLimit', () => {
  it('needs a whole number of at least 1: g2way refuses zero', () => {
    expect(parseLimit(' 60 ')).toEqual({ ok: true, value: 60 });
    expect(parseLimit('0')).toMatchObject({ ok: false });
    expect(parseLimit('1.5')).toMatchObject({ ok: false });
    expect(parseLimit('')).toEqual({ ok: false, problem: 'Required while the limit is on.' });
  });
});

describe('policyProblems', () => {
  it('passes a sound policy', () => {
    expect(policyProblems(gold)).toEqual({});
  });

  it('mirrors Policy::validate', () => {
    expect(
      policyProblems({
        policy_id: ' ',
        name: '',
        rate: { requests: 0, per_seconds: 60 },
        quota: { max: 10, renewal_rate_secs: 0 },
        access: { '': {} },
      }),
    ).toEqual({
      policy_id: expect.any(String),
      name: expect.any(String),
      rate: expect.any(String),
      quota: expect.any(String),
      access: expect.any(String),
    });
    expect(policyProblems({ ...gold, policy_id: 'a/b' }).policy_id).toMatch(/slashes/);
  });

  it('treats null limits as unlimited', () => {
    expect(policyProblems({ ...gold, rate: null, quota: null })).toEqual({});
  });
});

describe('isPolicyShape', () => {
  it('needs an object with policy_id and name as strings', () => {
    expect(isPolicyShape(gold)).toBe(true);
    expect(isPolicyShape({ policy_id: 'a' })).toBe(false);
    expect(isPolicyShape([gold])).toBe(false);
    expect(isPolicyShape(null)).toBe(false);
  });
});
