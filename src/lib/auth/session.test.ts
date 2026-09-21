import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataHandle } from '@/lib/db/users';

/**
 * A session is only as good as the org it was issued for (ADR-0004 §3,
 * ADR-0007). Every entry point — pages (`requireUser`/`requirePermission`),
 * server actions and the BFF (`withUser`) — resolves the caller through
 * `getCurrentUser`, so these drive the real one with a stubbed Auth.js session
 * and a real in-memory database, and prove a token from another org is signed
 * out everywhere. The orgs are stand-ins; the real one comes from `G2_ORG_ID`.
 */

const ORG = 'org-under-test';
const OTHER_ORG = 'another-org';

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; orgId: string | null },
  handle: undefined as DataHandle | undefined,
}));

vi.mock('@/auth', () => ({
  auth: async () => state.session,
  signIn: vi.fn(),
  signOut: vi.fn(async () => {}),
}));
vi.mock('next-auth', () => ({
  AuthError: class extends Error {},
  CredentialsSignin: class extends Error {},
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  getDatabase: () => state.handle,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  forbidden: () => {
    throw new Error('forbidden');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { migrateDatabase, openDatabase } = await import('@/lib/db');
const { createFirstOwner, listUsers } = await import('@/lib/db/users');
const { listAudit } = await import('@/lib/db/audit');
const { getCurrentUser, requirePermission, requireUser } = await import('./session');
const { withUser } = await import('./api');
const { createUserAction, updateUserAction } = await import('@/lib/users/actions');
const { signOutAction } = await import('./actions');

let ownerId: string;
const cleanup: (() => void)[] = [];

beforeEach(async () => {
  vi.stubEnv('G2_ORG_ID', ORG);
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  state.handle = database;
  const owner = await createFirstOwner(database, ORG, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: 'h',
  });
  ownerId = owner!.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  state.session = null;
  for (const fn of cleanup.splice(0)) fn();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('a session issued for another org', () => {
  beforeEach(() => {
    // A real user id of this org, in a token stamped for another org.
    state.session = { user: { id: ownerId }, orgId: OTHER_ORG };
  });

  it('resolves to no user', async () => {
    expect(await getCurrentUser()).toBeNull();
  });

  it('is sent to /login by every page guard', async () => {
    await expect(requireUser()).rejects.toThrow('redirect:/login');
    await expect(requirePermission('gateway:read')).rejects.toThrow('redirect:/login');
  });

  it('gets 401 from the BFF', async () => {
    const handler = vi.fn(async () => new Response('reached'));
    const response = await withUser(handler)(new Request('http://dash/api/g2/apis'));
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is refused by the user-management server actions, which change nothing', async () => {
    const created = await createUserAction(
      { error: null },
      form({
        email: 'eve@example.com',
        name: 'Eve',
        password: 'a long enough password',
        role: 'owner',
      }),
    );
    expect(created.error).toMatch(/session has ended/);
    const updated = await updateUserAction(
      { error: null },
      form({ userId: ownerId, role: 'viewer' }),
    );
    expect(updated.error).toMatch(/session has ended/);
    expect((await listUsers(state.handle!, ORG)).map((u) => u.email)).toEqual(['ada@example.com']);
  });

  it('is not audited as a sign-out of this org’s user', async () => {
    await signOutAction();
    const actions = (await listAudit(state.handle!, ORG)).entries.map((e) => e.action);
    expect(actions).not.toContain('auth.sign_out');
  });
});

describe('a session with no org claim', () => {
  it('resolves to no user', async () => {
    state.session = { user: { id: ownerId }, orgId: null };
    expect(await getCurrentUser()).toBeNull();
  });
});

describe('a session for this org (control)', () => {
  it('resolves to the user everywhere', async () => {
    state.session = { user: { id: ownerId }, orgId: ORG };
    expect(await getCurrentUser()).toMatchObject({ id: ownerId, orgId: ORG });
    expect(await requirePermission('users:manage')).toMatchObject({ id: ownerId });
    const response = await withUser(async (user) => Response.json({ id: user.id }))(
      new Request('http://dash/api/g2/apis'),
    );
    expect(await response.json()).toEqual({ id: ownerId });
    await signOutAction();
    const actions = (await listAudit(state.handle!, ORG)).entries.map((e) => e.action);
    expect(actions).toContain('auth.sign_out');
  });

  it('stops resolving once the dashboard is reconfigured for another org', async () => {
    state.session = { user: { id: ownerId }, orgId: ORG };
    vi.stubEnv('G2_ORG_ID', OTHER_ORG);
    expect(await getCurrentUser()).toBeNull();
  });
});
