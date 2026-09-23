import { describe, expect, it } from 'vitest';
import {
  GATEWAY_RECORD_CAP,
  WORKER_STALE_MS,
  ingestHealth,
  type IngestHealthInput,
  type IngestStateFields,
} from './health';

const T0 = new Date('2026-09-23T10:00:00Z');
const T1 = new Date('2026-09-23T10:00:30Z');
const T2 = new Date('2026-09-23T10:01:00Z');
/** The read happens shortly after the latest time above. */
const NOW = T2.getTime() + 5000;

function state(overrides: Partial<IngestStateFields> = {}): IngestStateFields {
  return {
    recordsIngested: 10,
    recordsRejected: 0,
    batches: 1,
    backlog: 0,
    lastDrainedAt: T0,
    lastPolledAt: T0,
    lastRecordAt: T0,
    lastRejection: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

function health(input: Partial<IngestHealthInput>) {
  return ingestHealth({
    redisConfigured: true,
    workerInServer: true,
    state: state(),
    now: NOW,
    ...input,
  });
}

describe('ingestHealth', () => {
  it('reports no Redis URL before anything else, ignoring a leftover row', () => {
    expect(health({ redisConfigured: false })).toMatchObject({
      status: 'not-configured',
      backlog: null,
      lastSeenAt: null,
      state: undefined,
    });
  });

  it('reports no-worker when no worker ever reported', () => {
    expect(health({ workerInServer: false, state: undefined })).toMatchObject({
      status: 'no-worker',
      backlog: null,
      lastSeenAt: null,
      workerInServer: false,
    });
  });

  it('reports no-worker when the last report is older than the stale window', () => {
    const now = T2.getTime() + WORKER_STALE_MS + 1;
    const stale = health({
      now,
      state: state({ lastPolledAt: T1, lastError: 'redis: down', lastErrorAt: T2 }),
    });
    // Even a last error counts as a report: the worker was alive then.
    expect(stale).toMatchObject({ status: 'no-worker', lastSeenAt: T2 });
    expect(health({ now: now - 1, state: state({ lastPolledAt: T2 }) }).status).toBe('ok');
  });

  it('reports not-sending when a worker polls but has never drained', () => {
    const idle = health({
      state: state({ lastDrainedAt: null, lastRecordAt: null, lastPolledAt: T2 }),
    });
    expect(idle).toMatchObject({ status: 'not-sending', lastSeenAt: T2 });
  });

  it('reports failing when an error came after the last successful pop', () => {
    expect(
      health({ state: state({ lastError: 'redis: ECONNREFUSED', lastErrorAt: T1 }) }).status,
    ).toBe('failing');
  });

  it('reports failing when the worker has errored and never polled', () => {
    const never = state({
      lastDrainedAt: null,
      lastPolledAt: null,
      lastError: 'redis: down',
      lastErrorAt: T1,
    });
    expect(health({ state: never }).status).toBe('failing');
  });

  it('stops reporting failing once an empty pop succeeds after the error', () => {
    const recovered = state({ lastPolledAt: T2, lastError: 'redis: blip', lastErrorAt: T1 });
    expect(health({ state: recovered }).status).toBe('ok');
    const recoveredIdle = { ...recovered, lastDrainedAt: null, lastRecordAt: null };
    expect(health({ state: recoveredIdle }).status).toBe('not-sending');
  });

  it('falls back to last_drained_at on a row an older worker wrote, with no heartbeat', () => {
    const legacy = state({
      lastPolledAt: null,
      lastDrainedAt: T2,
      lastError: 'x',
      lastErrorAt: T1,
    });
    expect(health({ state: legacy })).toMatchObject({
      status: 'ok',
      lastSeenAt: T2,
      backlog: { asOf: T2 },
    });
  });

  it('flags a backlog at 80 % of the cap, beside any status, as of the last poll', () => {
    const near = GATEWAY_RECORD_CAP * 0.8;
    expect(health({ state: state({ backlog: near - 1, lastPolledAt: T1 }) }).backlog).toEqual({
      count: near - 1,
      nearCap: false,
      asOf: T1,
    });

    const failing = health({
      state: state({ backlog: near, lastError: 'database: locked', lastErrorAt: T1 }),
    });
    expect(failing.status).toBe('failing');
    expect(failing.backlog).toEqual({ count: near, nearCap: true, asOf: T0 });
  });
});
