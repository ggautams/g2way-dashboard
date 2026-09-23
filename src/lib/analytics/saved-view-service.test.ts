import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@/lib/auth/rbac';
import { migrateDatabase, openDatabase } from '@/lib/db';
import { listAudit } from '@/lib/db/audit';
import { listSavedViews } from '@/lib/db/saved-views';
import type { DataHandle } from '@/lib/db/users';
import { parseEnvironments } from '@/lib/g2/environments';
import { deleteView, saveView } from './saved-view-service';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const registry = parseEnvironments({
  G2_ORG_ID: ORG,
  G2_ENVIRONMENTS: 'dev',
  G2_ENV_DEV_URL: 'http://gw-dev:9696',
  G2_ENV_DEV_SECRET: 'unused',
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  const handle: DataHandle = database;
  return { handle, orgId: ORG, registry };
}

const actorFor = (role: Role, id = `user-${role}`) => ({ id, email: `${id}@example.com`, role });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ environment: 'dev', ...fields })) {
    data.set(name, value);
  }
  return data;
}

const list = (deps: Awaited<ReturnType<typeof setup>>, ownerId: string) =>
  listSavedViews(deps.handle, ORG, { environment: 'dev', ownerId });

describe('saveView', () => {
  it('saves a personal view for a viewer, canonicalised', async () => {
    const deps = await setup();
    const viewer = actorFor('viewer');
    const state = await saveView(
      viewer,
      form({ name: ' Checkout ', query: 'by=path&api=checkout&range=6h' }),
      deps,
    );
    expect(state).toEqual({ error: null, notice: 'Saved “Checkout”. Only you see it.' });
    expect(await list(deps, viewer.id)).toMatchObject([
      { name: 'Checkout', shared: false, query: 'range=6h&api=checkout&by=path' },
    ]);
  });

  it('refuses sharing without analytics:share, and audits the refusal', async () => {
    const deps = await setup();
    const state = await saveView(
      actorFor('viewer'),
      form({ name: 'Team', query: 'range=1h', shared: 'on' }),
      deps,
    );
    expect(state.error).toMatch(/lacks the analytics:share permission/);
    expect(await list(deps, 'anyone')).toEqual([]);
    const { entries } = await listAudit(deps.handle, ORG);
    expect(entries).toMatchObject([
      { action: 'analytics.view.create', outcome: 'denied', actorRole: 'viewer' },
    ]);
  });

  it('shares for an editor', async () => {
    const deps = await setup();
    const state = await saveView(
      actorFor('editor'),
      form({ name: 'Team', query: 'range=1h', shared: 'on' }),
      deps,
    );
    expect(state.error).toBeNull();
    expect(await list(deps, 'someone-else')).toMatchObject([{ name: 'Team', shared: true }]);
  });

  it('refuses a portal account, a bad name, a bad window and an unknown environment', async () => {
    const deps = await setup();
    expect(
      (await saveView(actorFor('portal-dev'), form({ name: 'x', query: '' }), deps)).error,
    ).toMatch(/lacks the gateway:read permission/);
    expect((await saveView(actorFor('viewer'), form({ name: '', query: '' }), deps)).error).toBe(
      'Not saved: the view needs a name.',
    );
    expect(
      (await saveView(actorFor('viewer'), form({ name: 'x', query: 'from=nope&to=nope' }), deps))
        .error,
    ).toMatch(/^Not saved: from=nope/);
    expect(
      (
        await saveView(
          actorFor('viewer'),
          form({ name: 'x', query: '', environment: 'prod' }),
          deps,
        )
      ).error,
    ).toMatch(/prod/);
  });

  it('says so when the name is taken', async () => {
    const deps = await setup();
    const viewer = actorFor('viewer');
    await saveView(viewer, form({ name: 'Mine', query: '' }), deps);
    expect((await saveView(viewer, form({ name: 'Mine', query: 'range=6h' }), deps)).error).toMatch(
      /already have a view named “Mine”/,
    );
  });
});

describe('deleteView', () => {
  it('deletes the owner’s personal view and any shared view for a sharer', async () => {
    const deps = await setup();
    const viewer = actorFor('viewer');
    const editor = actorFor('editor');
    await saveView(viewer, form({ name: 'Mine', query: '' }), deps);
    await saveView(editor, form({ name: 'Team', query: '', shared: 'on' }), deps);
    const [team, mine] = await list(deps, viewer.id);

    // A viewer cannot delete the shared one; another editor can.
    expect((await deleteView(viewer, form({ id: team.id }), deps)).error).toMatch(
      /lacks the analytics:share permission/,
    );
    expect(
      await deleteView(actorFor('editor', 'other-editor'), form({ id: team.id }), deps),
    ).toEqual({ error: null, notice: 'Deleted “Team”.' });
    expect(await deleteView(viewer, form({ id: mine.id }), deps)).toEqual({
      error: null,
      notice: 'Deleted “Mine”.',
    });
  });

  it('answers someone else’s personal view as not found, and audits the attempt', async () => {
    const deps = await setup();
    await saveView(actorFor('viewer'), form({ name: 'Private', query: '' }), deps);
    const [view] = await list(deps, 'user-viewer');
    const state = await deleteView(actorFor('admin'), form({ id: view.id }), deps);
    expect(state.error).toBe('Not deleted: no such saved view in this environment.');
    expect(await list(deps, 'user-viewer')).toHaveLength(1);
    const { entries } = await listAudit(deps.handle, ORG);
    expect(entries[0]).toMatchObject({
      action: 'analytics.view.delete',
      outcome: 'denied',
      actorRole: 'admin',
    });
  });
});
