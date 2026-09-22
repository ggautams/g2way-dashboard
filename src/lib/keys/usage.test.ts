import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { USAGE_UPSTREAM_ITEM, effectiveLimits } from './usage';

const RATE = { requests: 10, per_seconds: 60 };
const QUOTA = { max: 1000, renewal_rate_secs: 86_400 };
const SRC = resolve(import.meta.dirname, '../..');

describe('effectiveLimits', () => {
  it("uses the key's own limits when it applies no policy", () => {
    expect(effectiveLimits({ rate: RATE, quota: QUOTA }, null)).toEqual({
      source: 'key',
      rate: RATE,
      quota: QUOTA,
    });
    expect(effectiveLimits({}, null)).toEqual({ source: 'key', rate: null, quota: null });
  });

  it("replaces the key's limits with the applied policy's, even an unlimited one", () => {
    const limits = effectiveLimits(
      { apply_policies: ['gold'], rate: RATE, quota: QUOTA },
      {
        ok: true,
        value: { policy_id: 'gold', name: 'Gold', quota: { max: 5, renewal_rate_secs: 60 } },
      },
    );
    expect(limits).toEqual({
      source: 'policy',
      policyId: 'gold',
      name: 'Gold',
      active: true,
      rate: null,
      quota: { max: 5, renewal_rate_secs: 60 },
    });
  });

  it('says so when the applied policy cannot be read, rather than falling back to the key', () => {
    expect(
      effectiveLimits(
        { apply_policies: ['gone'], rate: RATE },
        { ok: false, error: 'policy not found', status: 404 },
      ),
    ).toEqual({
      source: 'policy-unavailable',
      policyId: 'gone',
      error: 'policy not found',
      status: 404,
    });
  });
});

describe('the Usage panel', () => {
  const panel = readFileSync(resolve(SRC, 'components/keys/key-usage.tsx'), 'utf8');

  it('is a Server Component', () => {
    expect(panel).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it('reads no counters: no storage client, no fetch', () => {
    for (const file of ['components/keys/key-usage.tsx', 'lib/keys/usage.ts']) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      expect(source).not.toMatch(/\b(redis|ioredis|fetch\()/i);
    }
  });

  it('points at the UPSTREAM.md item', () => {
    const upstream = readFileSync(resolve(SRC, '../UPSTREAM.md'), 'utf8');
    expect(upstream).toContain(`**${USAGE_UPSTREAM_ITEM}**`);
  });

  // When g2way ships a usage endpoint this fails: proxy it, show the live
  // counters, tick the UPSTREAM.md box and the ROADMAP task.
  it('has no gateway endpoint to read yet', () => {
    expect(Object.keys(spec.paths).filter((path) => /usage/i.test(path))).toEqual([]);
  });
});
