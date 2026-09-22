import { describe, expect, it } from 'vitest';
import { schemaValidator } from '@/lib/designer/raw';
import { keyFieldHelp } from './field-help';
import { keySchema } from './schema';

describe('the KeySession schema', () => {
  const validate = schemaValidator(keySchema());

  it('accepts a sound session', () => {
    expect(
      validate({
        alias: 'mobile',
        active: true,
        apply_policies: ['gold'],
        rate: { requests: 10, per_seconds: 60 },
        expires_at: 1_790_000_000,
        access: { orders: {} },
      }),
    ).toEqual([]);
  });

  it('names a wrong type by path', () => {
    expect(validate({ rate: { requests: 'ten', per_seconds: 60 } }).map((p) => p.path)).toContain(
      '/rate/requests',
    );
  });
});

describe('keyFieldHelp', () => {
  it('has text for every field the form shows', () => {
    const help = keyFieldHelp();
    expect(help.active).toMatch(/soft revoke/);
    expect(help.apply_policies).toMatch(/Policies applied/);
    expect(Object.values(help).every((text) => text !== '')).toBe(true);
  });
});
