import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from '@/lib/db';
import * as pgSchema from '@/lib/db/schema/pg';
import type { DataHandle } from '@/lib/db/users';
import {
  checkThrottle,
  clientAddress,
  emailKey,
  noteFailure,
  noteSuccess,
  throttleKeys,
  type ThrottlePolicy,
} from './throttle';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const POLICY: ThrottlePolicy = { windowMs: 60_000, limits: { email: 3, client: 5 } };
const T0 = new Date('2026-09-23T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function sqliteMemory(): Promise<DataHandle> {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  return database;
}

async function pglite(): Promise<DataHandle> {
  const client = new PGlite();
  cleanup.push(() => client.close());
  const db = drizzlePglite(client, { schema: pgSchema });
  await migratePglite(db, { migrationsFolder: migrationsFolder('postgres') });
  return { dialect: 'postgres', db, schema: pgSchema };
}

describe('clientAddress', () => {
  it('takes the last X-Forwarded-For entry: the socket, or the proxy nearest us', () => {
    expect(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientAddress(new Headers({ 'x-forwarded-for': '10.0.0.1, 203.0.113.7 ' }))).toBe(
      '203.0.113.7',
    );
    expect(clientAddress(new Headers())).toBeNull();
    expect(clientAddress(new Headers({ 'x-forwarded-for': ' , ' }))).toBeNull();
  });
});

describe('emailKey', () => {
  it('normalises an address and hashes anything else, never storing it as typed', () => {
    expect(emailKey('  Ada@Example.com ')).toBe('ada@example.com');
    const pasted = emailKey('hunter2 correct horse');
    expect(pasted).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pasted).not.toContain('hunter2');
  });

  it('keys by email alone when there is no client address', () => {
    expect(throttleKeys('ada@example.com', null)).toEqual([
      { kind: 'email', key: 'ada@example.com' },
    ]);
  });
});

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('sign-in throttle on %s', (_name, open) => {
  const ada = throttleKeys('ada@example.com', '192.0.2.1');

  it('throttles an email at its limit, until the failures leave the window', async () => {
    const handle = await open();
    for (let i = 0; i < POLICY.limits.email; i += 1) {
      expect(await checkThrottle(handle, ORG, ada, at(i), POLICY)).toEqual({ throttled: false });
      await noteFailure(handle, ORG, ada, at(i), POLICY);
    }
    expect(await checkThrottle(handle, ORG, ada, at(10), POLICY)).toEqual({
      throttled: true,
      kind: 'email',
    });
    // The oldest failure (at 0) ages out once the window has passed it.
    expect(await checkThrottle(handle, ORG, ada, at(POLICY.windowMs + 1), POLICY)).toEqual({
      throttled: false,
    });
  });

  it('throttles a client spraying many emails', async () => {
    const handle = await open();
    for (let i = 0; i < POLICY.limits.client; i += 1) {
      await noteFailure(
        handle,
        ORG,
        throttleKeys(`user${i}@example.com`, '192.0.2.1'),
        at(i),
        POLICY,
      );
    }
    expect(
      await checkThrottle(
        handle,
        ORG,
        throttleKeys('fresh@example.com', '192.0.2.1'),
        at(9),
        POLICY,
      ),
    ).toEqual({ throttled: true, kind: 'client' });
    expect(
      await checkThrottle(
        handle,
        ORG,
        throttleKeys('fresh@example.com', '192.0.2.2'),
        at(9),
        POLICY,
      ),
    ).toEqual({ throttled: false });
  });

  it('a success clears the email, not the client', async () => {
    const handle = await open();
    for (let i = 0; i < POLICY.limits.client; i += 1)
      await noteFailure(handle, ORG, ada, at(i), POLICY);
    await noteSuccess(handle, ORG, ' ADA@example.com');
    expect(
      await checkThrottle(handle, ORG, throttleKeys('ada@example.com', null), at(9), POLICY),
    ).toEqual({ throttled: false });
    expect(await checkThrottle(handle, ORG, ada, at(9), POLICY)).toEqual({
      throttled: true,
      kind: 'client',
    });
  });

  it('keeps orgs apart and prunes rows no window can count', async () => {
    const handle = await open();
    for (let i = 0; i < POLICY.limits.email; i += 1)
      await noteFailure(handle, ORG, ada, at(i), POLICY);
    expect(await checkThrottle(handle, 'another-org', ada, at(9), POLICY)).toEqual({
      throttled: false,
    });
    await noteFailure(handle, ORG, [], at(POLICY.windowMs * 2), POLICY);
    const remaining =
      handle.dialect === 'sqlite'
        ? handle.db.select().from(handle.schema.loginFailures).all()
        : await handle.db.select().from(handle.schema.loginFailures);
    expect(remaining).toEqual([]);
  });
});
