import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { analyticsRecordsKey, parseAnalyticsRecord, type AnalyticsRecord } from './record';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';

/** The record g2way's own serde test uses (`crates/g2-core/src/analytics.rs`). */
const FULL: AnalyticsRecord = {
  timestamp_unix_ms: 1_756_600_000_000,
  api_id: 'users-api',
  org_id: ORG,
  method: 'GET',
  path: '/users/42',
  status: 200,
  latency_ms: 12,
  upstream_latency_ms: 9,
  key_hash: 'ab34',
  key_alias: 'mobile-app',
  client_ip: '10.0.0.9',
  user_agent: 'curl/8',
  response_content_length: 128,
};

describe('analyticsRecordsKey', () => {
  it('follows g2way’s key schema', () => {
    expect(analyticsRecordsKey('acme')).toBe('g2:acme:analytics:records');
  });
});

describe('parseAnalyticsRecord', () => {
  it('reads a full record as serialised by the sink', () => {
    expect(parseAnalyticsRecord(JSON.stringify(FULL), ORG)).toEqual({ ok: true, record: FULL });
  });

  it('reads a minimal record, as an older gateway wrote it', () => {
    const raw = `{"timestamp_unix_ms":1,"api_id":"a","org_id":"${ORG}","method":"GET","path":"/","status":200,"latency_ms":3}`;
    const parsed = parseAnalyticsRecord(raw, ORG);
    expect(parsed).toEqual({
      ok: true,
      record: {
        timestamp_unix_ms: 1,
        api_id: 'a',
        org_id: ORG,
        method: 'GET',
        path: '/',
        status: 200,
        latency_ms: 3,
      },
    });
  });

  it('ignores unknown fields and reads null optionals as absent, like serde', () => {
    const parsed = parseAnalyticsRecord(
      JSON.stringify({ ...FULL, key_hash: null, brand_new_field: [1] }),
      ORG,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record).not.toHaveProperty('key_hash');
      expect(parsed.record).not.toHaveProperty('brand_new_field');
    }
  });

  it.each([
    ['not JSON', '{', 'not JSON'],
    ['an array', '[]', 'not a JSON object'],
    ['null', 'null', 'not a JSON object'],
    ['no api_id', JSON.stringify({ ...FULL, api_id: undefined }), 'api_id is not a string'],
    ['a string status', JSON.stringify({ ...FULL, status: '200' }), 'status is not'],
    ['a status past u16', JSON.stringify({ ...FULL, status: 70000 }), 'status is not'],
    ['a negative latency', JSON.stringify({ ...FULL, latency_ms: -1 }), 'latency_ms is not'],
    ['a fractional timestamp', JSON.stringify({ ...FULL, timestamp_unix_ms: 1.5 }), 'timestamp'],
    ['a numeric key_hash', JSON.stringify({ ...FULL, key_hash: 7 }), 'key_hash is not a string'],
    ['a string length', JSON.stringify({ ...FULL, request_content_length: '9' }), 'request_'],
  ])('refuses %s', (_name, raw, reason) => {
    const parsed = parseAnalyticsRecord(raw, ORG);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  it('refuses a record naming another org, without quoting the record', () => {
    const parsed = parseAnalyticsRecord(JSON.stringify({ ...FULL, org_id: 'someone-else' }), ORG);
    expect(parsed).toEqual({ ok: false, reason: 'org_id is not the configured org' });
  });
});

describe('the hand-written type (UPSTREAM.md: AnalyticsRecord is not in the OpenAPI document)', () => {
  it('is still needed: the contracts carry no AnalyticsRecord schema', () => {
    // When this fails, g2way publishes the schema: alias `AnalyticsRecord` to
    // the generated type, keep only the parser, and tick the UPSTREAM.md TODO.
    const schemas = Object.keys(spec.components?.schemas ?? {});
    expect(schemas).not.toContain('AnalyticsRecord');
    const types = readFileSync(
      resolve(import.meta.dirname, '../../../contracts/g2way.d.ts'),
      'utf8',
    );
    expect(types).not.toMatch(/\bAnalyticsRecord\b/);
  });
});
