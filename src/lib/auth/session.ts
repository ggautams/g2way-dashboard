import 'server-only';

import { forbidden, redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { getDatabase } from '@/lib/db';
import { hasUsers, type User } from '@/lib/db/users';
import { getOrgId } from '@/lib/g2/environments';
import { resolveSessionUser } from './credentials';
import { can, type Permission } from './rbac';

/**
 * Who is making this request. The enforcement point for every page (through
 * `requireUser()`) and the BFF (through `@/lib/auth/api`), per ADR-0004.
 *
 * Verifies the Auth.js session cookie, then re-reads the account from the
 * database, so a disabled user is out on their next request. Memoised per
 * request with React `cache`, so a layout and its page cost one lookup.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await auth();
  if (!session) return null;
  return resolveSessionUser(getDatabase(), getOrgId(), {
    userId: session.user?.id,
    orgId: session.orgId,
    signedInAt: session.signedInAt,
  });
});

/** Whether first-run setup has happened for this org. */
export const isBootstrapped = cache(async (): Promise<boolean> =>
  hasUsers(getDatabase(), getOrgId()),
);

/**
 * The signed-in user, or a redirect: to `/setup` while the org has no users,
 * otherwise to `/login`. Call it at the top of every authenticated page — the
 * layout alone is not enough, because layouts are not re-rendered on client
 * navigations (`src/app/(app)/pages.test.ts` enforces it).
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (user) return user;
  redirect((await isBootstrapped()) ? '/login' : '/setup');
}

/**
 * {@link requireUser}, and then a 403 (`forbidden()`, rendering
 * `src/app/forbidden.tsx`) unless the user's role holds `permission`. The role
 * comes from the database on every request, so a demotion applies at once.
 * Pages whose nav section declares a permission must call this with it
 * (`src/app/(app)/pages.test.ts`).
 */
export async function requirePermission(permission: Permission): Promise<User> {
  const user = await requireUser();
  if (!can(user.role, permission)) forbidden();
  return user;
}

/** What the shell may show about the signed-in user. Never the password hash. */
export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'role'>;

export function toPublicUser({ id, email, name, role }: User): PublicUser {
  return { id, email, name, role };
}
