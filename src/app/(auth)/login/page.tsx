import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { LoginForm } from '@/components/auth/login-form';
import { loginAction } from '@/lib/auth/actions';
import { getCurrentUser, isBootstrapped } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  await connection();
  if (!(await isBootstrapped())) redirect('/setup');
  if (await getCurrentUser()) redirect('/');

  // Auth.js sends its own failures here as ?error=<type>; show the type verbatim.
  const { error } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted">to manage your g2way gateways.</p>
      <LoginForm
        action={loginAction}
        initialError={typeof error === 'string' ? `Sign-in failed (${error}).` : null}
      />
    </>
  );
}
