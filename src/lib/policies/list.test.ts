import { describe, expect, it } from 'vitest';
import {
  describeQuota,
  describeRate,
  describeSeconds,
  filterPolicies,
  summarisePolicy,
  type Policy,
} from './list';

const gold: Policy = {
  policy_id: 'gold',
  name: 'Gold tier',
  rate: { requests: 100, per_seconds: 60 },
  quota: { max: 10_000, renewal_rate_secs: 86_400 },
  access: { orders: {}, billing: {} },
};

describe('summarisePolicy', () => {
  it('applies g2way’s serde defaults: active, unlimited, every API', () => {
    expect(summarisePolicy({ policy_id: 'free', name: 'Free' })).toEqual({
      policyId: 'free',
      name: 'Free',
      active: true,
      rate: null,
      quota: null,
      apis: [],
    });
    expect(summarisePolicy({ ...gold, active: false, rate: null })).toMatchObject({
      active: false,
      rate: null,
      apis: ['orders', 'billing'],
    });
  });
});

describe('describing limits', () => {
  it('uses the largest whole unit', () => {
    expect(describeSeconds(1)).toBe('1 s');
    expect(describeSeconds(90)).toBe('90 s');
    expect(describeSeconds(120)).toBe('2 min');
    expect(describeSeconds(3_600)).toBe('1 h');
    expect(describeSeconds(86_400)).toBe('1 day');
    expect(describeSeconds(604_800)).toBe('7 days');
  });

  it('reads a limit per period, or unlimited', () => {
    expect(describeRate(gold.rate ?? null)).toBe('100 / 1 min');
    expect(describeQuota(gold.quota ?? null)).toBe('10000 / 1 day');
    expect(describeRate(null)).toBe('unlimited');
  });
});

describe('filterPolicies', () => {
  const all = [gold, { policy_id: 'free', name: 'Free' }].map(summarisePolicy);

  it('matches name, id or a granted api_id, case-insensitively', () => {
    expect(filterPolicies(all, '').map((p) => p.policyId)).toEqual(['gold', 'free']);
    expect(filterPolicies(all, 'TIER').map((p) => p.policyId)).toEqual(['gold']);
    expect(filterPolicies(all, 'billing').map((p) => p.policyId)).toEqual(['gold']);
    expect(filterPolicies(all, ' fre ').map((p) => p.policyId)).toEqual(['free']);
    expect(filterPolicies(all, 'nothing')).toEqual([]);
  });
});
