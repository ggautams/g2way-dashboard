import { withUser } from '@/lib/auth/api';
import { trafficExportResponse } from '@/lib/analytics/export';

// CSV export of an /analytics view (ADR-0013 §8): the time series or the
// breakdown of the selection in the URL, from the rollups or Prometheus, never
// from the live tail. Signed-in users only (401 otherwise); the role needs
// `gateway:read`, as the page does, and `keys:read` for any key column.

const handle = withUser(async (user, request: Request) => trafficExportResponse(request, user));

export const GET = handle;
