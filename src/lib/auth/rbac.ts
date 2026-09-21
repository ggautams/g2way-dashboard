import { ROLES, type Role } from '@/lib/db/schema/shared';

/**
 * The dashboard's role model (ADR-0005): roles grant permissions, and every
 * server-side entry point (BFF, pages, server actions) checks a permission,
 * never a role name. Universal and dependency-free, so the shell can hide what
 * a role cannot use — but hiding is cosmetic; the server checks are the
 * enforcement.
 */

export { ROLES, type Role };

export const PERMISSIONS = [
  /** Gateway status: `/g2/node`, `/g2/version`, `/g2/health`, `/g2/stats`. */
  'gateway:read',
  /** Read API definitions. */
  'apis:read',
  /** Create, replace and delete API definitions. */
  'apis:write',
  'policies:read',
  'policies:write',
  /** Read key sessions (the gateway lists hashes only). */
  'keys:read',
  /** Create, update and revoke keys: minting credentials is an admin act. */
  'keys:write',
  /** `POST /g2/reload`: make staged API/policy writes live. */
  'gateway:reload',
  /** `POST /g2/graphql/sync`: re-fetch upstream GraphQL schemas. */
  'graphql:sync',
  /** The users page. Who may change whom is decided by {@link userChangeDenial}. */
  'users:manage',
  /** The audit log (next task). */
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = ['gateway:read', 'apis:read', 'policies:read', 'keys:read'];
const EDITOR: readonly Permission[] = [
  ...VIEWER,
  'apis:write',
  'policies:write',
  'gateway:reload',
  'graphql:sync',
];
const ADMIN: readonly Permission[] = [...EDITOR, 'keys:write', 'users:manage', 'audit:read'];

/**
 * Role → permissions. `owner` and `admin` hold the same permissions; they
 * differ in whom they may manage ({@link ASSIGNABLE_ROLES}). `portal-dev` is a
 * developer-portal account (M10) and holds no gateway admin access at all.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: ADMIN,
  editor: EDITOR,
  viewer: VIEWER,
  'portal-dev': [],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * The roles each role may grant, and equally the roles of the accounts it may
 * modify. Owners manage everyone, owners included; admins manage only accounts
 * below admin and cannot create or promote to admin or owner.
 */
export const ASSIGNABLE_ROLES: Readonly<Record<Role, readonly Role[]>> = {
  owner: ROLES,
  admin: ['editor', 'viewer', 'portal-dev'],
  editor: [],
  viewer: [],
  'portal-dev': [],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Why `actor` may not give `target` the role `nextRole` (or create a new
 * account with it, when `target` is `null`), or `null` when allowed.
 * Enabling or disabling an account passes the target's current role.
 *
 * Rules: the actor needs `users:manage`; nobody changes their own account
 * (so nobody can escalate themselves, or lock themselves out); the actor must be
 * able to assign both the target's current role and the new one. The "last
 * active owner" invariant is not here: it needs the whole table, so the data
 * layer enforces it inside its transaction (`@/lib/db/users`).
 */
export function userChangeDenial(
  actor: { id: string; role: Role },
  target: { id: string; role: Role } | null,
  nextRole: Role,
): string | null {
  if (!can(actor.role, 'users:manage')) {
    return `the ${actor.role} role lacks the users:manage permission`;
  }
  if (target !== null && target.id === actor.id) {
    return 'you cannot change your own account; ask another owner';
  }
  const assignable = ASSIGNABLE_ROLES[actor.role];
  if (target !== null && !assignable.includes(target.role)) {
    return `an ${actor.role} cannot modify an account with the ${target.role} role`;
  }
  if (!assignable.includes(nextRole)) {
    return `an ${actor.role} cannot grant the ${nextRole} role`;
  }
  return null;
}
