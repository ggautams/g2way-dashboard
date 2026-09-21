import 'server-only';

import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { recordSignIn } from '@/lib/auth/audit';
import { attemptSignIn } from '@/lib/auth/credentials';
import { clientAddress } from '@/lib/auth/throttle';
import { getDatabase } from '@/lib/db';
import { getOrgId } from '@/lib/g2/environments';

/**
 * Auth.js: email + password against the dashboard's own `users` table, with
 * stateless JWT sessions in an encrypted cookie keyed by `AUTH_SECRET`
 * (ADR-0004). The token carries only the user id and org; who the user is,
 * whether they are still enabled and (next) their role are re-read from the
 * database on every request by `getCurrentUser()` in `@/lib/auth/session`.
 *
 * Server-only: `AUTH_SECRET` never reaches the browser.
 */

/** The account exists and the password is right, but it is disabled. */
class AccountDisabled extends CredentialsSignin {
  code = 'disabled';
}

/** Too many recent failures for this email or client; the password was not checked. */
class SignInThrottled extends CredentialsSignin {
  code = 'throttled';
}

/** An admin console: a stolen cookie should not outlive a working day. */
const SESSION_MAX_AGE_S = 12 * 60 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      // `request` carries the browser's headers, also when `signIn()` runs in
      // a server action (Auth.js copies them from `next/headers`).
      async authorize(credentials, request) {
        const { email, password } = credentials;
        if (typeof email !== 'string' || typeof password !== 'string') return null;
        const client = clientAddress(request.headers);
        const result = await attemptSignIn(getDatabase(), getOrgId(), { email, password, client });
        await recordSignIn(getDatabase(), getOrgId(), email, result);
        if (!result.ok) {
          if (result.reason === 'disabled') throw new AccountDisabled();
          if (result.reason === 'throttled') throw new SignInThrottled();
          return null;
        }
        return { id: result.user.id, email: result.user.email, name: result.user.name };
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_S },
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    jwt({ token, user }) {
      // `user` is present only on sign-in: stamp the org the account belongs to.
      if (user) token.orgId = getOrgId();
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? '';
      session.orgId = typeof token.orgId === 'string' ? token.orgId : null;
      return session;
    },
  },
});

declare module 'next-auth' {
  interface Session {
    /** The org the session was issued for; a mismatch with config signs the user out. */
    orgId: string | null;
  }
}

export const { GET, POST } = handlers;
