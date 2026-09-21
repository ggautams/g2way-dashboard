import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { SetupForm } from '@/components/auth/setup-form';
import { setupAction } from '@/lib/auth/actions';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/forms';
import { isBootstrapped } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Set up' };

/** First run only: creates the org's owner. Gone for good once any user exists. */
export default async function SetupPage() {
  await connection();
  if (await isBootstrapped()) redirect('/login');
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Create the owner account</h1>
      <p className="mt-1 text-sm text-muted">
        This dashboard has no users yet. The first account becomes its owner; this page disappears
        once it exists.
      </p>
      <SetupForm action={setupAction} minPasswordLength={MIN_PASSWORD_LENGTH} />
    </>
  );
}
