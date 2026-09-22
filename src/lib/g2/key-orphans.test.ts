import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { migrateDatabase, openDatabase } from '@/lib/db';
import { getAuditEntry, listAudit } from '@/lib/db/audit';
import { listAllKeyMetadata, upsertKeyMetadata } from '@/lib/db/key-metadata';
import type { DataHandle } from '@/lib/db/users';
import { parseEnvironments } from './environments';
import type { Outcome } from './gateway-status';
import { ORPHAN_NOTE, checkKeyOrphans, pruneKeyOrphans } from './key-orphans';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev,staging',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'unused',
  G2_ENV_STAGING_URL: 'http://gw-staging:9696',
  G2_ENV_STAGING_SECRET: 'unused',
});
const LIVE = 'a'.repeat(64);
const GONE = 'b'.repeat(64);
const ALSO_GONE = 'c'.repeat(64);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const actorFor = (role: Role) => ({ id: `user-${role}`, email: `${role}@example.com`, role });

/** A database with metadata for LIVE, GONE and ALSO_GONE in dev, and GONE in staging. */
async function database(): Promise<DataHandle> {
  const handle = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => handle.close());
  await migrateDatabase(handle);
  const put = (environment: string, keyHash: string) =>
    upsertKeyMetadata(handle, ORG, {
      environment,
      keyHash,
      fields: { label: `label ${keyHash[0]}`, owner: 'team', notes: null },
      actor: actorFor('admin'),
    });
  for (const hash of [LIVE, GONE, ALSO_GONE]) await put('dev', hash);
  await put('staging', GONE);
  return handle;
}

const listed = (outcome: Outcome<string[]>) => async (): Promise<Outcome<string[]>> => outcome;

function form(hashes: string[], environment = 'dev'): FormData {
  const data = new FormData();
  data.set('environment', environment);
  for (const hash of hashes) data.append('hash', hash);
  return data;
}

describe('checkKeyOrphans', () => {
  it('names the rows of this environment the gateway no longer lists', async () => {
    const handle = await database();
    const check = await checkKeyOrphans('dev', {
      handle,
      orgId: ORG,
      listKeys: listed({ ok: true, value: [LIVE] }),
    });
    if (!check.ok) throw new Error(check.error);
    expect(check.orphans.map((row) => row.keyHash).sort()).toEqual([GONE, ALSO_GONE]);
  });

  it('names none when GET /g2/keys fails', async () => {
    const handle = await database();
    expect(
      await checkKeyOrphans('dev', {
        handle,
        orgId: ORG,
        listKeys: listed({ ok: false, error: 'storage unavailable', status: 503 }),
      }),
    ).toEqual({
      ok: false,
      error: 'GET /g2/keys failed, so no key can be judged gone: storage unavailable (HTTP 503)',
    });
  });
});

describe('pruneKeyOrphans', () => {
  it('removes only rows that are orphans now, each audited as key.metadata.delete', async () => {
    const handle = await database();
    const state = await pruneKeyOrphans(actorFor('admin'), form([GONE, LIVE]), {
      handle,
      orgId: ORG,
      registry,
      listKeys: listed({ ok: true, value: [LIVE] }),
    });
    expect(state.error).toBeNull();
    expect(state.pruned).toEqual([GONE]);
    expect(state.kept?.map((k) => k.hash)).toEqual([LIVE]);

    const left = (await listAllKeyMetadata(handle, ORG, 'dev')).map((row) => row.keyHash).sort();
    // ALSO_GONE was not asked for, so it stays; the staging row is another environment.
    expect(left).toEqual([LIVE, ALSO_GONE]);
    expect((await listAllKeyMetadata(handle, ORG, 'staging')).map((r) => r.keyHash)).toEqual([
      GONE,
    ]);

    const { entries } = await listAudit(handle, ORG);
    const deletes = entries.filter((e) => e.action === 'key.metadata.delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ target: GONE, environment: 'dev', outcome: 'success' });
    const entry = await getAuditEntry(handle, ORG, deletes[0].id);
    expect(entry?.note).toContain(ORPHAN_NOTE);
    expect(entry?.before).toMatchObject({ key_hash: GONE, label: 'label b', owner: 'team' });
  });

  it('prunes nothing when the gateway list fails', async () => {
    const handle = await database();
    const state = await pruneKeyOrphans(actorFor('admin'), form([GONE, ALSO_GONE]), {
      handle,
      orgId: ORG,
      registry,
      listKeys: listed({ ok: false, error: 'gateway unreachable (environment dev): fetch failed' }),
    });
    expect(state.error).toBe(
      'Nothing pruned: GET /g2/keys failed, so no key can be judged gone: gateway unreachable (environment dev): fetch failed',
    );
    expect(await listAllKeyMetadata(handle, ORG, 'dev')).toHaveLength(3);
    const { entries } = await listAudit(handle, ORG);
    expect(entries.some((e) => e.action === 'key.metadata.delete')).toBe(false);
  });

  it('keeps a row whose key the gateway lists again by the time of the prune', async () => {
    const handle = await database();
    const state = await pruneKeyOrphans(actorFor('owner'), form([GONE]), {
      handle,
      orgId: ORG,
      registry,
      listKeys: listed({ ok: true, value: [LIVE, GONE, ALSO_GONE] }),
    });
    expect(state.pruned).toEqual([]);
    expect(state.kept).toHaveLength(1);
    expect(await listAllKeyMetadata(handle, ORG, 'dev')).toHaveLength(3);
  });

  it('refuses a role without keys:write, audited as denied, without reading the gateway', async () => {
    const handle = await database();
    let reads = 0;
    const state = await pruneKeyOrphans(actorFor('editor'), form([GONE]), {
      handle,
      orgId: ORG,
      registry,
      listKeys: async () => {
        reads += 1;
        return { ok: true, value: [] };
      },
    });
    expect(state.error).toMatch(/^Forbidden: the editor role lacks the keys:write permission/);
    expect(reads).toBe(0);
    expect(await listAllKeyMetadata(handle, ORG, 'dev')).toHaveLength(3);
    const { entries } = await listAudit(handle, ORG);
    expect(entries.find((e) => e.action === 'key.metadata.delete')).toMatchObject({
      outcome: 'denied',
    });
  });

  it('refuses an unknown environment and an empty selection', async () => {
    const handle = await database();
    const deps = { handle, orgId: ORG, registry, listKeys: listed({ ok: true, value: [] }) };
    expect((await pruneKeyOrphans(actorFor('admin'), form([GONE], 'nowhere'), deps)).error).toMatch(
      /nowhere/,
    );
    expect((await pruneKeyOrphans(actorFor('admin'), form([]), deps)).error).toBe(
      'Nothing selected to prune.',
    );
  });
});
