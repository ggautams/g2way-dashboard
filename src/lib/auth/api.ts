import 'server-only';

import type { User } from '@/lib/db/users';
import { getCurrentUser } from './session';

/**
 * Guards a route handler: without a live session the request is answered 401 in
 * the gateway's own `{"error": "..."}` envelope, so BFF callers handle it like
 * any gateway error, and the handler — and the gateway — are never reached.
 */
export function withUser<Args extends unknown[]>(
  handler: (user: User, request: Request, ...args: Args) => Promise<Response>,
  getUser: () => Promise<User | null> = getCurrentUser,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const user = await getUser();
    if (user === null) {
      return Response.json(
        { error: 'authentication required: sign in to the dashboard' },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      );
    }
    return handler(user, request, ...args);
  };
}
