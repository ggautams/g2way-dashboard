import type { Metadata } from 'next';
import { CreateUserForm } from '@/components/users/create-user-form';
import { UserRowControls } from '@/components/users/user-row-controls';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/forms';
import { ASSIGNABLE_ROLES, ROLES, permissionsFor, userChangeDenial } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listUsers } from '@/lib/db/users';
import { getOrgId } from '@/lib/g2/environments';
import { createUserAction, resetPasswordAction, updateUserAction } from '@/lib/users/actions';

export const metadata: Metadata = { title: 'Users & roles' };

const ROLE_SUMMARY: Record<(typeof ROLES)[number], string> = {
  owner: 'Everything, including managing other owners and admins.',
  admin: 'Everything an editor can, plus keys, the audit log and accounts below admin.',
  editor: 'Everything a viewer can, plus API and policy writes, reload and GraphQL sync.',
  viewer: 'Read-only: gateway status, APIs, policies and keys.',
  'portal-dev': 'No gateway admin access; for the developer portal (M10).',
};

/**
 * Dashboard accounts. Owners and admins only; the controls offered per row are
 * a courtesy — the server actions and the data layer re-check every rule
 * (ADR-0005), including that the org always keeps an active owner.
 */
export default async function UsersPage() {
  const actor = await requirePermission('users:manage');
  const users = await listUsers(getDatabase(), getOrgId());
  const assignable = ASSIGNABLE_ROLES[actor.role];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <p className="mt-1 text-sm text-muted">
          Dashboard accounts. Role changes, disabling and password resets take effect on the
          user&apos;s next request; a reset also ends their existing sessions.
        </p>
      </header>

      <section aria-labelledby="accounts" className="flex flex-col gap-3">
        <h2 id="accounts" className="text-lg font-medium">
          Accounts
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const denial = userChangeDenial(actor, user, user.role);
                return (
                  <tr key={user.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">
                        {user.name}
                        {user.id === actor.id && (
                          <span className="ml-2 text-xs font-normal text-muted">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">{user.email}</p>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{user.role}</td>
                    <td className="px-3 py-2">
                      {user.disabled ? (
                        <span className="text-xs text-danger">disabled</span>
                      ) : (
                        <span className="text-xs text-success">active</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {denial === null ? (
                        <UserRowControls
                          userId={user.id}
                          email={user.email}
                          role={user.role}
                          disabled={user.disabled}
                          roles={assignable}
                          action={updateUserAction}
                          resetAction={resetPasswordAction}
                          minPasswordLength={MIN_PASSWORD_LENGTH}
                        />
                      ) : (
                        <span className="text-xs text-muted" title={denial}>
                          {user.id === actor.id ? 'Your own account' : 'Not yours to manage'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="create" className="flex flex-col gap-3">
        <h2 id="create" className="text-lg font-medium">
          Create a user
        </h2>
        <div className="rounded-lg border border-border bg-surface p-4">
          <CreateUserForm
            action={createUserAction}
            roles={assignable}
            minPasswordLength={MIN_PASSWORD_LENGTH}
          />
        </div>
      </section>

      <section aria-labelledby="roles" className="flex flex-col gap-3">
        <h2 id="roles" className="text-lg font-medium">
          Roles
        </h2>
        <dl className="grid gap-2 text-sm">
          {ROLES.map((role) => (
            <div key={role} className="grid gap-1 sm:grid-cols-[8rem_1fr]">
              <dt className="font-mono text-xs">{role}</dt>
              <dd className="text-muted">
                {ROLE_SUMMARY[role]}{' '}
                <span className="font-mono text-xs">
                  ({permissionsFor(role).join(', ') || 'no permissions'})
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
