import { withUser } from '@/lib/auth/api';
import { sendConsoleRequest } from '@/lib/g2/console';

// The request console (ADR-0011): one test request through the selected
// environment's proxy listener, never its admin API, answered with the
// response and an inferred middleware trace. Only the literal path
// `/api/g2/console` lands here; every other `/api/g2/...` path is still the
// `[...path]` proxy. Signed-in users only (401 otherwise); the role needs
// `apis:test`.

const handle = withUser(async (user, request: Request) =>
  sendConsoleRequest(request, { id: user.id, email: user.email, role: user.role }),
);

export const POST = handle;
