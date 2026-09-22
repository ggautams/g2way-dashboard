import { withUser } from '@/lib/auth/api';
import { rotateKey } from '@/lib/g2/rotate-key';

// Key rotation, orchestrated by the BFF because g2way has no rotate endpoint
// (ADR-0009): read the session, create a key with it, delete the old one, each
// call through the audited proxy, all under one `key.rotate` audit row. Only the
// literal path `/api/g2/keys/<hash>/rotate` lands here; every other `/api/g2/...`
// path is still the `[...path]` proxy. Signed-in users only (401 otherwise); the
// role needs `keys:write`.

type Context = RouteContext<'/api/g2/keys/[hash]/rotate'>;

const handle = withUser(async (user, request: Request, context: Context) => {
  const { hash } = await context.params;
  return rotateKey(request, hash, { id: user.id, email: user.email, role: user.role });
});

export const POST = handle;
