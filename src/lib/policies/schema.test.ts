import { describe, expect, it } from 'vitest';
import { schemaValidator } from '@/lib/designer/raw';
import { policyFieldHelp } from './field-help';
import type { Policy } from './list';
import { policySchema } from './schema';

const gold: Policy = {
  policy_id: 'gold',
  name: 'Gold',
  active: true,
  rate: { requests: 100, per_seconds: 60 },
  quota: { max: 1000, renewal_rate_secs: 86_400 },
  access: { orders: { max_query_depth: 5 } },
};

describe('the Policy schema', () => {
  const schema = policySchema();
  const validate = schemaValidator(schema);

  it('carries the policy and only the schemas it references', () => {
    const names = Object.keys((schema.components as { schemas: object }).schemas);
    expect(names).toEqual(expect.arrayContaining(['Policy', 'RateLimit', 'Quota', 'ApiAccess']));
    expect(names).not.toContain('ApiDefinition');
  });

  it('accepts a sound policy, and null limits', () => {
    expect(validate(gold)).toEqual([]);
    expect(validate({ ...gold, rate: null, quota: null })).toEqual([]);
  });

  it('names what is wrong, by path', () => {
    expect(validate({ policy_id: 'gold' })).toContainEqual({
      path: '(top level)',
      message: 'missing "name"',
    });
    expect(
      validate({ ...gold, rate: { requests: 'ten', per_seconds: 60 } }).map((p) => p.path),
    ).toContain('/rate/requests');
  });
});

describe('policyFieldHelp', () => {
  it('has g2way’s description for every field the form shows', () => {
    const help = policyFieldHelp();
    expect(help.active).toMatch(/denies every key/);
    expect(help.rate).toMatch(/unlimited/);
    expect(help['quota.renewal_rate_secs']).toMatch(/renewal period/);
    expect(Object.values(help).every((text) => text !== '')).toBe(true);
  });
});
