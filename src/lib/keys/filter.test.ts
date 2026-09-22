import { describe, expect, it } from 'vitest';
import {
  NO_POLICY,
  isFiltering,
  keyFilterQuery,
  keyState,
  matchKey,
  parseKeyFilter,
  scanOrder,
  type KeyFilter,
} from './filter';
import { toKeyListRow } from './list-row';
import { summariseKey } from './session';

const NOW = 1_700_000_000;
const filter = (over: Partial<KeyFilter> = {}): KeyFilter => ({
  q: '',
  policy: '',
  state: 'all',
  ...over,
});

describe('parseKeyFilter', () => {
  it('reads q, policy and state from the query, trimming, first value wins', () => {
    expect(
      parseKeyFilter({ q: ' Billing ', policy: ['gold', 'silver'], state: 'revoked' }),
    ).toEqual({ q: 'Billing', policy: 'gold', state: 'revoked' });
  });

  it('falls back to "all" for anything unrecognised', () => {
    expect(parseKeyFilter({ state: 'deleted' })).toEqual(filter());
    expect(isFiltering(parseKeyFilter({}))).toBe(false);
    expect(isFiltering(filter({ state: 'expired' }))).toBe(true);
    expect(isFiltering(filter({ policy: NO_POLICY }))).toBe(true);
  });

  it('round-trips through keyFilterQuery, keeping the page', () => {
    const f = filter({ q: 'a b', policy: 'gold', state: 'active' });
    const query = keyFilterQuery(f, 3);
    expect(query).toBe('?q=a+b&policy=gold&state=active&page=3');
    expect(parseKeyFilter(Object.fromEntries(new URLSearchParams(query.slice(1))))).toEqual(f);
    expect(keyFilterQuery(filter())).toBe('');
    expect(keyFilterQuery(filter(), 2)).toBe('?page=2');
  });
});

describe('matchKey', () => {
  const hash = 'ab12'.padEnd(64, '0');
  const key = (session: Parameters<typeof summariseKey>[1]) => summariseKey(hash, session);
  const labels = { label: 'Checkout service', owner: 'Payments team' };

  it('matches q against label, owner, alias and a hash prefix, case-insensitively', () => {
    const summary = key({ alias: 'billing-prod' });
    expect(matchKey({ hash, labels, summary }, filter({ q: 'checkout' }), NOW)).toBe('match');
    expect(matchKey({ hash, labels, summary }, filter({ q: 'PAYMENTS' }), NOW)).toBe('match');
    expect(matchKey({ hash, summary }, filter({ q: 'Billing' }), NOW)).toBe('match');
    expect(matchKey({ hash, summary }, filter({ q: 'ab12' }), NOW)).toBe('match');
    expect(matchKey({ hash, labels, summary }, filter({ q: 'nomatch' }), NOW)).toBe('no');
  });

  it('filters by policy, "no policy", and state (revoked wins over expired)', () => {
    const gold = key({ apply_policies: ['gold'] });
    expect(matchKey({ hash, summary: gold }, filter({ policy: 'gold' }), NOW)).toBe('match');
    expect(matchKey({ hash, summary: gold }, filter({ policy: 'silver' }), NOW)).toBe('no');
    expect(matchKey({ hash, summary: gold }, filter({ policy: NO_POLICY }), NOW)).toBe('no');
    expect(matchKey({ hash, summary: key({}) }, filter({ policy: NO_POLICY }), NOW)).toBe('match');

    const revokedAndExpired = key({ active: false, expires_at: NOW - 1 });
    expect(keyState(revokedAndExpired, NOW)).toBe('revoked');
    expect(keyState(key({ expires_at: NOW }), NOW)).toBe('expired');
    expect(keyState(key({}), NOW)).toBe('active');
    expect(
      matchKey({ hash, summary: key({ expires_at: NOW - 5 }) }, filter({ state: 'expired' }), NOW),
    ).toBe('match');
    expect(matchKey({ hash, summary: key({}) }, filter({ state: 'revoked' }), NOW)).toBe('no');
  });

  it('combines the three with AND', () => {
    const summary = key({ alias: 'billing', apply_policies: ['gold'], active: false });
    const all = filter({ q: 'bill', policy: 'gold', state: 'revoked' });
    expect(matchKey({ hash, summary }, all, NOW)).toBe('match');
    expect(matchKey({ hash, summary }, { ...all, state: 'active' }, NOW)).toBe('no');
  });

  it('never counts an unreadable session as a miss', () => {
    // A label match stands on its own when nothing else is asked.
    expect(matchKey({ hash, labels, summary: null }, filter({ q: 'checkout' }), NOW)).toBe('match');
    // Alias, policy and state need the session: unknown, not "no".
    expect(matchKey({ hash, summary: null }, filter({ q: 'billing' }), NOW)).toBe('unknown');
    expect(matchKey({ hash, labels, summary: null }, filter({ policy: 'gold' }), NOW)).toBe(
      'unknown',
    );
    expect(matchKey({ hash, summary: null }, filter({ state: 'active' }), NOW)).toBe('unknown');
  });
});

describe('scanOrder', () => {
  it('reads label/owner matches first, each group in gateway order', () => {
    const labels = new Map([
      ['c', { label: 'Checkout', owner: null }],
      ['e', { label: null, owner: 'checkout team' }],
    ]);
    expect(scanOrder(['a', 'b', 'c', 'd', 'e'], labels, 'checkout')).toEqual([
      'c',
      'e',
      'a',
      'b',
      'd',
    ]);
    expect(scanOrder(['a', 'b'], labels, '')).toEqual(['a', 'b']);
  });
});

describe('toKeyListRow', () => {
  const hash = 'f'.repeat(64);

  it('ships display strings only, never the session (which may hold secrets)', () => {
    const row = toKeyListRow(
      hash,
      { ok: true, value: { alias: 'billing', hmac: { secret: 'do-not-ship' }, active: true } },
      { label: 'Checkout', owner: 'payments' },
      NOW,
    );
    expect(JSON.stringify(row)).not.toContain('do-not-ship');
    expect(row).toMatchObject({
      title: 'Checkout',
      alias: 'billing',
      owner: 'payments',
      state: 'active',
      everyApi: true,
      error: null,
    });
  });

  it('keeps a failed read as an error row with the gateway message', () => {
    const row = toKeyListRow(
      hash,
      { ok: false, error: 'corrupt record', status: 500 },
      undefined,
      NOW,
    );
    expect(row).toMatchObject({ title: null, error: 'corrupt record (HTTP 500)', state: null });
  });
});
