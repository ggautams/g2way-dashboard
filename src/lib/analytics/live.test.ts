import { describe, expect, it } from 'vitest';
import type { AnalyticsTailRow } from '@/lib/db/analytics';
import { toLiveRequest } from './live';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const HASH = 'f'.repeat(64);

function row(overrides: Partial<AnalyticsTailRow> = {}): AnalyticsTailRow {
  return {
    id: 'row-1',
    orgId: ORG,
    environment: 'prod',
    at: new Date(Date.UTC(2026, 8, 23, 10, 0, 0)),
    apiId: 'users',
    method: 'GET',
    path: '/users/42',
    pathTemplate: '/users/{id}',
    status: 200,
    latencyMs: 12,
    upstreamLatencyMs: 9,
    keyHash: HASH,
    keyAlias: 'mobile',
    requestBytes: null,
    responseBytes: 512,
    ...overrides,
  };
}

describe('toLiveRequest', () => {
  it('leaves the key out entirely without keys:read, and never sends the org', () => {
    const request = toLiveRequest(row(), null);
    expect(request).not.toHaveProperty('key');
    expect(JSON.stringify(request)).not.toContain(HASH);
    expect(JSON.stringify(request)).not.toContain('mobile');
    expect(request).not.toHaveProperty('orgId');
    expect(request).toMatchObject({ path: '/users/42', pathTemplate: '/users/{id}', status: 200 });
  });

  it('names a key by dashboard label, else alias, else short hash', () => {
    const labels = new Map([[HASH, { label: 'Checkout app' }]]);
    expect(toLiveRequest(row(), labels).key).toEqual({
      hash: HASH,
      label: 'Checkout app',
      detail: `${HASH.slice(0, 12)}…`,
      mono: false,
    });
    expect(toLiveRequest(row(), new Map()).key?.label).toBe('mobile');
    expect(toLiveRequest(row({ keyAlias: null }), new Map()).key).toMatchObject({
      label: `${HASH.slice(0, 12)}…`,
      mono: true,
    });
  });

  it('shows keyless requests as such', () => {
    expect(toLiveRequest(row({ keyHash: null, keyAlias: null }), new Map()).key).toEqual({
      hash: null,
      label: 'No key',
      detail: 'keyless requests',
      mono: false,
    });
  });
});
