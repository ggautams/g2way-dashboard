import { describe, expect, it } from 'vitest';
import { GATEWAY_RECORD_CAP, ingestHealth, type IngestStateFields } from './health';

const T0 = new Date('2026-09-23T10:00:00Z');
const T1 = new Date('2026-09-23T10:05:00Z');

function state(overrides: Partial<IngestStateFields> = {}): IngestStateFields {
  return {
    recordsIngested: 10,
    recordsRejected: 0,
    batches: 1,
    backlog: 0,
    lastDrainedAt: T0,
    lastRecordAt: T0,
    lastRejection: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

describe('ingestHealth', () => {
  it('reports no Redis URL before anything else, ignoring a leftover row', () => {
    const health = ingestHealth({ redisConfigured: false, workerInServer: true, state: state() });
    expect(health).toMatchObject({ status: 'not-configured', backlog: null, state: undefined });
  });

  it('reports not-sending when no worker ever reported', () => {
    const health = ingestHealth({ redisConfigured: true, workerInServer: false, state: undefined });
    expect(health).toMatchObject({ status: 'not-sending', backlog: null, workerInServer: false });
  });

  it('reports not-sending when the row exists but nothing was ever drained', () => {
    const health = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ lastDrainedAt: null, lastRecordAt: null }),
    });
    expect(health.status).toBe('not-sending');
  });

  it('reports failing when an error came after the last drain', () => {
    const health = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ lastError: 'redis: ECONNREFUSED', lastErrorAt: T1 }),
    });
    expect(health.status).toBe('failing');
  });

  it('reports failing when the worker has errored and never drained', () => {
    const health = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ lastDrainedAt: null, lastError: 'redis: down', lastErrorAt: T0 }),
    });
    expect(health.status).toBe('failing');
  });

  it('reports ok when the last drain is newer than the last error', () => {
    const health = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ lastDrainedAt: T1, lastError: 'redis: blip', lastErrorAt: T0 }),
    });
    expect(health.status).toBe('ok');
  });

  it('flags a backlog at 80 % of the cap, beside any status', () => {
    const near = GATEWAY_RECORD_CAP * 0.8;
    const ok = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ backlog: near - 1 }),
    });
    expect(ok.backlog).toEqual({ count: near - 1, nearCap: false, asOf: T0 });

    const failing = ingestHealth({
      redisConfigured: true,
      workerInServer: true,
      state: state({ backlog: near, lastError: 'database: locked', lastErrorAt: T1 }),
    });
    expect(failing.status).toBe('failing');
    expect(failing.backlog).toEqual({ count: near, nearCap: true, asOf: T0 });
  });
});
