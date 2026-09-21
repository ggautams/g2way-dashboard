import type { Metadata } from 'next';
import { ChangePasswordForm } from '@/components/account/change-password-form';
import { Notice } from '@/components/users/controls';
import { changePasswordAction } from '@/lib/auth/actions';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/forms';
import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Your account' };

/**
 * The signed-in user's own account: who they are, and changing their password.
 * Every role has one, so this needs no permission beyond being signed in.
 */
export default async function AccountPage({ searchParams }: PageProps<'/account'>) {
  const user = await requireUser();
  const { changed } = await searchParams;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="mt-1 text-sm text-muted">
          {user.name} · {user.email} · <span className="font-mono text-xs">{user.role}</span>
        </p>
      </header>

      <section aria-labelledby="password" className="flex flex-col gap-3">
        <h2 id="password" className="text-lg font-medium">
          Password
        </h2>
        <p className="text-sm text-muted">
          Changing it signs out every other session of this account, on any device.
        </p>
        {changed === '1' && <Notice message="Password changed. Other sessions have ended." />}
        <ChangePasswordForm action={changePasswordAction} minPasswordLength={MIN_PASSWORD_LENGTH} />
      </section>
    </div>
  );
}
