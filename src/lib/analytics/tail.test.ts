import { describe, expect, it } from 'vitest';
import { parseDrill } from './drill';
import type { AnalyticsRecord } from './record';
import { MAX_PATH_LENGTH } from './rollup';
import { TAIL_MAX_AGE_MS, liveHref, livePollUrl, tailEntries, tailFilter } from './tail';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const NOW = Date.UTC(2026, 8, 23, 10, 15, 30);

function record(overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    timestamp_unix_ms: NOW - 1000,
    api_id: 'users',
    org_id: ORG,
    method: 'GET',
    path: '/users/42',
    status: 200,
    latency_ms: 12,
    ...overrides,
  };
}

const template = (r: AnalyticsRecord) => r.path.replace(/\/\d+$/, '/{id}');

describe('tailEntries', () => {
  it('projects a record: raw and templated path, never the client IP or User-Agent', () => {
    const [entry] = tailEntries(
      [
        record({
          upstream_latency_ms: 9,
          key_hash: 'a'.repeat(64),
          key_alias: 'mobile',
          client_ip: '203.0.113.7',
          user_agent: 'curl/8.0',
          request_content_length: 10,
          response_content_length: 2048,
        }),
      ],
      template,
      10,
      NOW,
    );
    expect(entry).toEqual({
      at: new Date(NOW - 1000),
      apiId: 'users',
      method: 'GET',
      path: '/users/42',
      pathTemplate: '/users/{id}',
      status: 200,
      latencyMs: 12,
      upstreamLatencyMs: 9,
      keyHash: 'a'.repeat(64),
      keyAlias: 'mobile',
      requestBytes: 10,
      responseBytes: 2048,
    });
    expect(JSON.stringify(entry)).not.toMatch(/203\.0\.113\.7|curl/);
  });

  it('fills absent optionals with null', () => {
    const [entry] = tailEntries([record()], template, 10, NOW);
    expect(entry).toMatchObject({
      upstreamLatencyMs: null,
      keyHash: null,
      keyAlias: null,
      requestBytes: null,
      responseBytes: null,
    });
  });

  it('keeps the newest `limit`, newest first, later pops winning ties', () => {
    const records = [
      record({ timestamp_unix_ms: NOW - 3000, path: '/a' }),
      record({ timestamp_unix_ms: NOW - 1000, path: '/b' }),
      record({ timestamp_unix_ms: NOW - 2000, path: '/c' }),
      record({ timestamp_unix_ms: NOW - 1000, path: '/d' }),
    ];
    expect(tailEntries(records, template, 3, NOW).map((e) => e.path)).toEqual(['/d', '/b', '/c']);
  });

  it('skips records already past the tail age, and keeps nothing at limit 0', () => {
    const records = [
      record({ timestamp_unix_ms: NOW - TAIL_MAX_AGE_MS - 1, path: '/old' }),
      record({ timestamp_unix_ms: NOW - TAIL_MAX_AGE_MS, path: '/edge' }),
    ];
    expect(tailEntries(records, template, 10, NOW).map((e) => e.path)).toEqual(['/edge']);
    expect(tailEntries(records, template, 0, NOW)).toEqual([]);
  });

  it('truncates both paths as the rollups do', () => {
    const long = `/${'x'.repeat(MAX_PATH_LENGTH + 10)}`;
    const [entry] = tailEntries([record({ path: long })], (r) => r.path, 1, NOW);
    expect(entry?.path).toHaveLength(MAX_PATH_LENGTH);
    expect(entry?.pathTemplate).toHaveLength(MAX_PATH_LENGTH);
  });
});

describe('tailFilter', () => {
  const filter = (params: Record<string, string>) => tailFilter(parseDrill(params, { keys: true }));

  it('reads the drill-down selection', () => {
    expect(filter({})).toEqual({});
    expect(filter({ api: 'users' })).toEqual({ apiId: 'users' });
    expect(filter({ api: 'users', status: '5xx' })).toEqual({ apiId: 'users', statusClass: 5 });
    expect(filter({ status: '503' })).toEqual({ status: 503 });
    expect(filter({ method: 'POST' })).toEqual({ method: 'POST' });
    expect(filter({ path: '/users/{id}' })).toEqual({ pathTemplate: '/users/{id}' });
    expect(filter({ key: 'abc' })).toEqual({ keyHash: 'abc' });
    expect(filter({ key: '' })).toEqual({ keyHash: null });
  });

  it('ignores a key without keys:read, as the drill-down does', () => {
    expect(tailFilter(parseDrill({ key: 'abc' }, { keys: false }))).toEqual({});
  });
});

describe('liveHref / livePollUrl', () => {
  it('write the selection in drillHref order', () => {
    expect(liveHref({ apiId: null, focus: null })).toBe('/analytics/live');
    const selection = { apiId: 'a b', focus: { dimension: 'path' as const, value: '/u/{id}' } };
    expect(liveHref(selection)).toBe('/analytics/live?api=a+b&path=%2Fu%2F%7Bid%7D');
    expect(livePollUrl(selection)).toBe('/api/analytics/live?api=a+b&path=%2Fu%2F%7Bid%7D');
    expect(livePollUrl({ apiId: null, focus: null })).toBe('/api/analytics/live');
  });

  it('round-trips through parseDrill', () => {
    const selection = { apiId: 'users', focus: { dimension: 'status' as const, value: '4xx' } };
    const params = Object.fromEntries(new URL(liveHref(selection), 'http://x').searchParams);
    const drill = parseDrill(params, { keys: true });
    expect({ apiId: drill.apiId, focus: drill.focus }).toEqual(selection);
  });
});
