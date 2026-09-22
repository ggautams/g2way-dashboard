'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth/session';
import { getRegistry } from './environments';
import { ENVIRONMENT_COOKIE } from './selected-environment';

/**
 * The shell's environment switcher. Remembers the choice in a cookie holding
 * only the public id, after checking it is configured; any signed-in user may
 * switch, since what they can do in each environment is still their role's.
 */
export async function selectEnvironmentAction(formData: FormData): Promise<void> {
  if ((await getCurrentUser()) === null) return;
  const id = formData.get('environment');
  if (typeof id !== 'string' || !getRegistry().environments.some((env) => env.id === id)) return;
  (await cookies()).set(ENVIRONMENT_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.AUTH_URL?.startsWith('https:'),
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath('/', 'layout');
}
