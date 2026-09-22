import { withUser } from '@/lib/auth/api';
import { runBulkOperation } from '@/lib/g2/bulk';

// Bulk operations on keys and policies. g2way has no batch endpoint, so the BFF
// makes one gateway call per item, each through the audited proxy, under one
// `key.bulk`/`policy.bulk` summary row. Only the literal path `/api/g2/bulk`
// lands here; every other `/api/g2/...` path is still the `[...path]` proxy.
// Signed-in users only (401 otherwise); the role needs `keys:write` or
// `policies:write` for the collection.

const handle = withUser(async (user, request: Request) =>
  runBulkOperation(request, { id: user.id, email: user.email, role: user.role }),
);

export const POST = handle;
