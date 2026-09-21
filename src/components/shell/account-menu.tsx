import { signOutAction } from '@/lib/auth/actions';
import type { PublicUser } from '@/lib/auth/session';
import { SignOutIcon } from './icons';

/**
 * The signed-in user and a sign-out button. A Server Component handed to the
 * client sidebar as a slot, so the sign-out server action is bound here and the
 * sidebar imports nothing from the auth layer.
 */
export function AccountMenu({ user, compact = false }: { user: PublicUser; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {!compact && (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={user.name}>
            {user.name}
          </p>
          <p className="truncate text-xs text-muted" title={user.email}>
            {user.email} · <span className="uppercase tracking-wide">{user.role}</span>
          </p>
        </div>
      )}
      <form action={signOutAction}>
        <button
          type="submit"
          aria-label={`Sign out ${user.email}`}
          title="Sign out"
          className="rounded-md border border-border p-1.5 text-muted transition-colors hover:text-foreground"
        >
          <SignOutIcon />
        </button>
      </form>
    </div>
  );
}
