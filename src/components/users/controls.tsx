/** Presentational pieces shared by the users page forms. */

import type { Role } from '@/lib/auth/rbac';

export function RoleSelect({
  roles,
  ...select
}: { roles: readonly Role[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...select}
      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
    >
      {roles.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}

export function Notice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm text-success"
    >
      {message}
    </p>
  );
}
