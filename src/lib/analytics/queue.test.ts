import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '@/lib/db';
import { getIngestState } from '@/lib/db/analytics';
import { drainOnce } from './ingest';
import { redisErrorMessage, redisQueue } from './queue';
import { analyticsRecordsKey } from './record';

describe('redisErrorMessage', () => {
  const url = 'redis://user:s3cr%2Ft@redis.internal:6379/0';

  it('prefers the error code', () => {
    const error = Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED' });
    expect(redisErrorMessage(error, url)).toBe('redis: ECONNREFUSED');
  });

  it('cuts the URL and the decoded password out of a message', () => {
    const message = redisErrorMessage(new Error(`cannot reach ${url}; auth s3cr/t refused`), url);
    expect(message).toBe('redis: cannot reach <redis url>; auth *** refused');
  });

  it('says nothing about a non-error', () => {
    expect(redisErrorMessage('boom', url)).toBe('redis: unknown error');
  });
});

it('reports an unreachable Redis as a rejected call, not a crash', async () => {
  // Port 1 refuses: no server needed.
  const queue = redisQueue('redis://127.0.0.1:1', 'g2:any:analytics:records');
  await expect(queue.drain(10)).rejects.toBeDefined();
  await expect(queue.length()).rejects.toBeDefined();
  await queue.close();
});

// Needs a real Redis (6.2+ for LPOP with a count): `make test-redis` provides
// one and sets TEST_REDIS_URL. Plain `npm run test` skips this block.
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!TEST_REDIS_URL)('redisQueue against a live Redis', () => {
  const key = `g2:test-${randomUUID()}:analytics:records`;
  const writer = createClient({ url: TEST_REDIS_URL });

  beforeAll(async () => {
    await writer.connect();
  });
  afterAll(async () => {
    await writer.del(key);
    writer.destroy();
  });

  it('drains FIFO in batches, reports the length, and answers [] for a missing list', async () => {
    const queue = redisQueue(TEST_REDIS_URL!, key);
    expect(await queue.drain(10)).toEqual([]);
    // What g2way's RedisListSink does: RPUSH, oldest at the head.
    await writer.rPush(key, ['a', 'b', 'c']);
    expect(await queue.length()).toBe(3);
    expect(await queue.drain(2)).toEqual(['a', 'b']);
    expect(await queue.length()).toBe(1);
    expect(await queue.drain(10)).toEqual(['c']);
    expect(await queue.drain(10)).toEqual([]);
    await queue.close();
  });

  it('reconnects after close', async () => {
    const queue = redisQueue(TEST_REDIS_URL!, key);
    await writer.rPush(key, ['x']);
    await queue.close();
    expect(await queue.drain(10)).toEqual(['x']);
    await queue.close();
  });

  it('feeds the ingest loop end to end: sink-shaped records in, rollups out', async () => {
    const org = `test-${randomUUID()}`;
    const listKey = analyticsRecordsKey(org);
    const records = [200, 200, 503].map((status, i) =>
      JSON.stringify({
        timestamp_unix_ms: Date.UTC(2026, 8, 23, 10, 0, i),
        api_id: 'users',
        org_id: org,
        method: 'GET',
        path: '/users/1',
        status,
        latency_ms: 10 + i,
      }),
    );
    await writer.rPush(listKey, records);
    const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
    try {
      await migrateDatabase(database);
      const queue = redisQueue(TEST_REDIS_URL!, listKey);
      const result = await drainOnce(
        { environment: 'live', queue, redisUrl: TEST_REDIS_URL! },
        {
          handle: database,
          orgId: org,
          config: { batchSize: 100, minuteRetentionDays: 3, hourRetentionDays: 90 },
          signal: new AbortController().signal,
        },
      );
      await queue.close();
      expect(result).toEqual({ kind: 'written', popped: 3 });
      expect(await writer.lLen(listKey)).toBe(0);
      expect(await getIngestState(database, org, 'live')).toMatchObject({
        recordsIngested: 3,
        backlog: 0,
      });
    } finally {
      await database.close();
      await writer.del(listKey);
    }
  });
});
