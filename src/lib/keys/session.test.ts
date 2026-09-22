import { describe, expect, it } from 'vitest';
import { PayloadShapeError } from '@/lib/g2/node';
import {
  fromDateTimeLocal,
  grantsEveryApi,
  isExpired,
  isKeyShape,
  keyProblems,
  newKeyDraft,
  otherKeyFields,
  pageOf,
  parseCreatedKey,
  parseKeyList,
  shortHash,
  summariseKey,
  toDateTimeLocal,
  withKeyField,
  type KeySession,
} from './session';

const HASH = 'a'.repeat(64);

describe('parseKeyList', () => {
  it('reads the hashes out of {"keys": […]}', () => {
    expect(parseKeyList({ keys: ['h1', 'h2'] })).toEqual(['h1', 'h2']);
    expect(parseKeyList({ keys: [] })).toEqual([]);
  });

  it('fails loudly when the shape moves', () => {
    expect(() => parseKeyList(['h1'])).toThrow(PayloadShapeError);
    expect(() => parseKeyList({ keys: [1] })).toThrow(/GET \/g2\/keys: expected keys/);
  });
});

describe('parseCreatedKey', () => {
  it('reads the raw key and its hash', () => {
    expect(parseCreatedKey({ key: 'raw', key_hash: HASH })).toEqual({ key: 'raw', key_hash: HASH });
  });

  it('names what is missing without quoting a raw key', () => {
    expect(() => parseCreatedKey({ key_hash: HASH })).toThrow(/expected key to be/);
    expect(() => parseCreatedKey({ key: 'raw-secret-value' })).toThrow(/key_hash/);
    try {
      parseCreatedKey({ key: 'raw-secret-value', key_hash: 7 });
    } catch (error) {
      expect(String(error)).not.toContain('raw-secret-value');
    }
  });
});

describe('summariseKey', () => {
  it('applies g2way’s serde defaults', () => {
    expect(summariseKey(HASH, {})).toEqual({
      hash: HASH,
      alias: null,
      active: true,
      expiresAt: null,
      policy: null,
      rate: null,
      quota: null,
      apis: [],
    });
  });

  it('reads the one applied policy, the limits and the granted APIs', () => {
    const session: KeySession = {
      alias: 'mobile',
      active: false,
      expires_at: 1_790_000_000,
      apply_policies: ['gold'],
      rate: { requests: 10, per_seconds: 60 },
      access: { orders: {}, users: {} },
    };
    expect(summariseKey(HASH, session)).toMatchObject({
      alias: 'mobile',
      active: false,
      expiresAt: 1_790_000_000,
      policy: 'gold',
      rate: { requests: 10, per_seconds: 60 },
      apis: ['orders', 'users'],
    });
  });
});

describe('small helpers', () => {
  it('isExpired', () => {
    expect(isExpired(null, 100)).toBe(false);
    expect(isExpired(100, 100)).toBe(true);
    expect(isExpired(101, 100)).toBe(false);
  });

  it('shortHash', () => {
    expect(shortHash(HASH)).toBe(`${'a'.repeat(12)}…`);
    expect(shortHash('short')).toBe('short');
  });

  it('isKeyShape takes any object', () => {
    expect(isKeyShape({})).toBe(true);
    expect(isKeyShape([])).toBe(false);
    expect(isKeyShape(null)).toBe(false);
  });
});

describe('pageOf', () => {
  const items = Array.from({ length: 53 }, (_, i) => i);

  it('slices one page and counts the rest', () => {
    expect(pageOf(items, 2, 25)).toEqual({
      items: items.slice(25, 50),
      page: 2,
      pages: 3,
      total: 53,
    });
  });

  it('clamps a page out of range, or not a number, into range', () => {
    expect(pageOf(items, 99, 25).page).toBe(3);
    expect(pageOf(items, 0, 25).page).toBe(1);
    expect(pageOf(items, Number.NaN, 25).page).toBe(1);
    expect(pageOf([], 1, 25)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});

describe('the draft', () => {
  it('starts active and grants every API until access is set', () => {
    const draft = newKeyDraft();
    expect(draft).toEqual({ active: true });
    expect(grantsEveryApi(draft)).toBe(true);
    expect(grantsEveryApi({ access: { orders: {} } })).toBe(false);
  });

  it('sets and removes one field, keeping the rest', () => {
    const draft: KeySession = { alias: 'a', hmac: { secret: 's' } };
    expect(withKeyField(draft, 'apply_policies', ['gold'])).toEqual({
      ...draft,
      apply_policies: ['gold'],
    });
    expect(withKeyField(draft, 'alias', undefined)).toEqual({ hmac: { secret: 's' } });
    expect(otherKeyFields({ ...draft, org_id: 'x', access: {} })).toEqual(['hmac', 'access']);
  });

  it('finds what KeySession::validate would refuse, and the one-policy limit', () => {
    expect(keyProblems({})).toEqual({});
    expect(
      keyProblems({
        rate: { requests: 0, per_seconds: 60 },
        quota: { max: 1, renewal_rate_secs: 0 },
        apply_policies: ['a', 'b'],
        expires_at: -1,
        access: { ' ': {} },
      }),
    ).toEqual({
      rate: expect.any(String),
      quota: expect.any(String),
      apply_policies: 'g2way applies at most one policy per key.',
      expires_at: expect.any(String),
      access: expect.any(String),
    });
  });
});

describe('expiry as datetime-local', () => {
  it('round-trips to the minute in the local zone', () => {
    const secs = Math.floor(new Date(2027, 0, 15, 9, 30).getTime() / 1000);
    expect(toDateTimeLocal(secs)).toBe('2027-01-15T09:30');
    expect(fromDateTimeLocal('2027-01-15T09:30')).toBe(secs);
  });

  it('reads blank as never and garbage as nothing', () => {
    expect(toDateTimeLocal(null)).toBe('');
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('not a date')).toBeNull();
  });
});
