import { withUser } from '@/lib/auth/api';
import { proxyToGateway } from '@/lib/g2/proxy';

// The BFF proxy onto the gateway admin API: `/api/g2/<path>` → `<gateway>/g2/<path>`.
// Runs server-side only; the admin secret is attached here and never leaves the server.
// Requires a signed-in dashboard user (401 otherwise), checked before anything else,
// whose role (fresh from the database) holds the operation's permission (403 otherwise).

type Context = RouteContext<'/api/g2/[...path]'>;

const handle = withUser(async (user, request: Request, context: Context) => {
  const { path } = await context.params;
  return proxyToGateway(request, path, user.role);
});

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
