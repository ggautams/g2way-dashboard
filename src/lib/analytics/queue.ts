import 'server-only';

import { createClient } from 'redis';

/**
 * The gateway's analytics record list, as the ingest worker sees it
 * (ADR-0012 §1): pop from the head, read the length. Nothing else — the
 * dashboard never writes to the gateway's Redis.
 */
export interface RecordQueue {
  /** Removes and returns up to `max` elements from the head (oldest first). */
  drain(max: number): Promise<string[]>;
  /** The list's current length. */
  length(): Promise<number>;
  close(): Promise<void>;
}

/**
 * A Redis error as it may be stored and shown: the error code when there is
 * one (`ECONNREFUSED`), otherwise the message with the URL and its password cut
 * out. Never the URL itself.
 */
export function redisErrorMessage(error: unknown, url: string): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return `redis: ${code}`;
    let message = error.message.split(url).join('<redis url>');
    try {
      const password = decodeURIComponent(new URL(url).password);
      if (password !== '') message = message.split(password).join('***');
    } catch {
      // Not a parsable URL: nothing more to cut.
    }
    return `redis: ${message}`;
  }
  return 'redis: unknown error';
}

/**
 * The list at `key` in the Redis at `url` (`LPOP key count` needs Redis 6.2+,
 * which g2way's own `list_drain` requires too).
 *
 * Connects lazily and does not reconnect in the background: after a failure
 * the client is dropped, and the next call dials again. The worker decides
 * when that is, so a dead Redis costs one attempt per backoff step, not a
 * reconnect storm, and never an unhandled `error` event.
 */
export function redisQueue(url: string, key: string): RecordQueue {
  const open = () =>
    createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 5000, reconnectStrategy: false },
    });
  type Client = ReturnType<typeof open>;
  let client: Client | null = null;

  async function connected(): Promise<Client> {
    if (client?.isReady) return client;
    await drop();
    const fresh = open();
    // Without a listener an `error` event would crash the process; the
    // failing command rejects too, and that is where it is handled.
    fresh.on('error', () => {});
    client = fresh;
    await fresh.connect();
    return fresh;
  }

  async function drop(): Promise<void> {
    const old = client;
    client = null;
    if (old === null) return;
    try {
      old.destroy();
    } catch {
      // Already closed.
    }
  }

  async function run<T>(command: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await command(await connected());
    } catch (error) {
      await drop();
      throw error;
    }
  }

  return {
    drain: (max) => run(async (c) => (await c.lPopCount(key, max)) ?? []),
    length: () => run((c) => c.lLen(key)),
    close: drop,
  };
}
