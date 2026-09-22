import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '@/lib/db';
import { recordVersion } from '@/lib/db/config-versions';
import type { DataHandle } from '@/lib/db/users';
import { SECRET_MASK } from '@/lib/secrets/redact';
import { loadHistory, toHistoryEntry } from './load-history';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const actor = { id: 'u1', email: 'ada@example.com', role: 'editor' as const };

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function sqliteMemory(): Promise<DataHandle> {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  return database;
}

describe('loadHistory', () => {
  it('returns a policy’s versions newest first, baseline last, as browser entries', async () => {
    const handle = await sqliteMemory();
    const p1 = { policy_id: 'gold', name: 'Gold', rate: 100 };
    const p2 = { ...p1, rate: 500 };
    const common = { environment: 'prod', kind: 'policy' as const, resourceId: 'gold', actor };
    await recordVersion(handle, ORG, {
      ...common,
      action: 'update',
      before: p1,
      after: p2,
      auditId: 'a1',
    });
    // Another kind and another org stay out.
    await recordVersion(handle, ORG, {
      ...common,
      kind: 'api',
      action: 'update',
      before: null,
      after: p2,
      auditId: 'a2',
    });
    await recordVersion(handle, 'other-org', {
      ...common,
      action: 'update',
      before: null,
      after: p2,
      auditId: 'a3',
    });

    const history = await loadHistory(
      handle,
      ORG,
      {
        environment: 'prod',
        kind: 'policy',
        resourceId: 'gold',
      },
      'viewer',
    );
    expect(history.map((h) => [h.action, h.definition, h.actorEmail])).toEqual([
      ['update', p2, 'ada@example.com'],
      ['baseline', p1, null],
    ]);
    expect(typeof history[0].createdAt).toBe('string');
    expect(new Date(history[0].createdAt).toISOString()).toBe(history[0].createdAt);
  });

  it('masks a stored definition’s secrets for a role that cannot write it (ADR-0010)', async () => {
    const handle = await sqliteMemory();
    const v1 = { api_id: 'billing', auth: { mode: 'jwt', secret: 'old-secret' } };
    const v2 = { api_id: 'billing', auth: { mode: 'jwt', secret: 'new-secret' } };
    await recordVersion(handle, ORG, {
      environment: 'prod',
      kind: 'api',
      resourceId: 'billing',
      actor,
      action: 'update',
      before: v1,
      after: v2,
      auditId: 'a1',
    });
    const resource = { environment: 'prod', kind: 'api' as const, resourceId: 'billing' };
    const masked = { api_id: 'billing', auth: { mode: 'jwt', secret: SECRET_MASK } };
    const read = await loadHistory(handle, ORG, resource, 'viewer');
    expect(read.map((h) => h.definition)).toEqual([masked, masked]);
    expect(JSON.stringify(read)).not.toMatch(/old-secret|new-secret/);
    const written = await loadHistory(handle, ORG, resource, 'editor');
    expect(written.map((h) => h.definition)).toEqual([v2, v1]);
  });

  it('keeps a delete’s null definition at the seam', () => {
    const entry = toHistoryEntry(
      {
        id: 'v1',
        orgId: ORG,
        environment: 'prod',
        kind: 'api',
        resourceId: 'x',
        action: 'delete',
        definition: null,
        actorId: null,
        actorEmail: null,
        auditId: null,
        createdAt: new Date(0),
      },
      'viewer',
    );
    expect(entry.definition).toBeNull();
  });

  it('is the only way pages read versions (the redaction seam)', () => {
    const app = resolve(import.meta.dirname, '../../app');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(app);
    walk(resolve(import.meta.dirname, '../../components'));
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('listVersions'));
    expect(offenders).toEqual([]);
    const pages = ['apis/view/[id]/page.tsx', 'policies/view/[id]/page.tsx'].map((p) =>
      readFileSync(join(app, '(app)', p), 'utf8'),
    );
    for (const page of pages) expect(page).toContain('loadHistory(');
  });
});
