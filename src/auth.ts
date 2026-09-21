import 'server-only';

import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { checkCredentials } from '@/lib/auth/credentials';
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

/** An admin console: a stolen cookie should not outlive a working day. */
const SESSION_MAX_AGE_S = 12 * 60 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      async authorize(credentials) {
        const { email, password } = credentials;
        if (typeof email !== 'string' || typeof password !== 'string') return null;
        const result = await checkCredentials(getDatabase(), getOrgId(), email, password);
        if (!result.ok) {
          if (result.reason === 'disabled') throw new AccountDisabled();
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
