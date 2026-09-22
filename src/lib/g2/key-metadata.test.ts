import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { migrateDatabase, openDatabase } from '@/lib/db';
import { listAudit } from '@/lib/db/audit';
import { getKeyMetadata } from '@/lib/db/key-metadata';
import type { DataHandle } from '@/lib/db/users';
import { parseEnvironments } from './environments';
import type { Outcome } from './gateway-status';
import { saveKeyMetadata } from './key-metadata';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'unused',
});
const HASH = 'd'.repeat(64);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function database(): Promise<DataHandle> {
  const handle = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => handle.close());
  await migrateDatabase(handle);
  return handle;
}

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ environment: 'dev', hash: HASH, ...fields })) {
    data.set(name, value);
  }
  return data;
}

const exists = async (): Promise<Outcome<unknown>> => ({ ok: true, value: { active: true } });

describe('saveKeyMetadata', () => {
  it('saves for keys:write, after confirming the key exists, and audits it', async () => {
    const handle = await database();
    const reads: string[] = [];
    const state = await saveKeyMetadata(
      actorFor('admin'),
      form({ label: ' Checkout ', owner: 'payments', notes: '' }),
      {
        handle,
        orgId: ORG,
        registry,
        readKey: async (env, hash) => {
          reads.push(`${env} ${hash}`);
          return exists();
        },
      },
    );
    expect(state).toMatchObject({
      error: null,
      saved: { label: 'Checkout', owner: 'payments', notes: null },
    });
    expect(reads).toEqual([`dev ${HASH}`]);
    const row = await getKeyMetadata(handle, ORG, { environment: 'dev', keyHash: HASH });
    expect(row?.createdBy).toBe('admin@example.com');
    const { entries } = await listAudit(handle, ORG);
    expect(entries.map((e) => [e.action, e.outcome, e.target])).toEqual([
      ['key.metadata.update', 'success', HASH],
    ]);
  });

  it('refuses a role without keys:write, and audits the refusal', async () => {
    const handle = await database();
    const state = await saveKeyMetadata(actorFor('editor'), form({ label: 'x' }), {
      handle,
      orgId: ORG,
      registry,
      readKey: exists,
    });
    expect(state.error).toBe(
      'Forbidden: the editor role lacks the keys:write permission (key metadata).',
    );
    const { entries } = await listAudit(handle, ORG);
    expect(entries.map((e) => [e.action, e.outcome])).toEqual([['key.metadata.update', 'denied']]);
    expect(
      await getKeyMetadata(handle, ORG, { environment: 'dev', keyHash: HASH }),
    ).toBeUndefined();
  });

  it('quotes the gateway when the key cannot be read, and saves nothing', async () => {
    const handle = await database();
    const state = await saveKeyMetadata(actorFor('owner'), form({ label: 'x' }), {
      handle,
      orgId: ORG,
      registry,
      readKey: async () => ({ ok: false, error: 'key not found', status: 404 }),
    });
    expect(state.error).toBe(`Not saved: GET /g2/keys/${HASH} failed: key not found (HTTP 404)`);
    expect(
      await getKeyMetadata(handle, ORG, { environment: 'dev', keyHash: HASH }),
    ).toBeUndefined();
  });

  it('refuses unknown environments, bad hashes and over-long fields', async () => {
    const handle = await database();
    const deps = { handle, orgId: ORG, registry, readKey: exists };
    const actor = actorFor('owner');
    expect((await saveKeyMetadata(actor, form({ environment: 'prod' }), deps)).error).toMatch(
      /prod/,
    );
    expect((await saveKeyMetadata(actor, form({ hash: 'a/b' }), deps)).error).toBe(
      'Not a key hash: a/b',
    );
    expect((await saveKeyMetadata(actor, form({ label: 'x'.repeat(121) }), deps)).error).toBe(
      'Not saved: label is 121 characters; the limit is 120.',
    );
  });
});
