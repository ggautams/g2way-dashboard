import { withUser } from '@/lib/auth/api';
import { liveRequestsResponse } from '@/lib/analytics/live';

// The live request inspector's poll (ADR-0014): the selected environment's
// newest requests from the dashboard database's tail, which the ingest worker
// fills from the batch in hand. Never the gateway, never Redis. Signed-in
// users only (401 otherwise); the role needs `analytics:inspect`.

const handle = withUser(async (user, request: Request) => liveRequestsResponse(request, user));

export const GET = handle;
