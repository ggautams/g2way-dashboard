import 'server-only';

import type { ApiDefinition } from '@/lib/apis/list';
import { unwrap } from './client';
import { resolveEnvironment } from './environments';
import { settle, type Outcome } from './gateway-status';
import { gatewayClient, type GatewayClientDeps } from './server-client';

/**
 * API definitions as the gateway stores them (`GET /g2/apis`, org-scoped by the
 * server client). Storage, not the data plane: a definition written since the
 * last reload is listed here before it routes (`docs/g2way-map.md`).
 */

export type ApiList = { environment: string; apis: Outcome<ApiDefinition[]> };

/**
 * Lists environment `environmentId`'s definitions. Registry errors are thrown,
 * as for `loadGatewayStatus`; gateway and network failures are settled so the
 * page can quote them.
 */
export async function loadApis(
  environmentId?: string,
  deps: GatewayClientDeps = {},
): Promise<ApiList> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return { environment: id, apis: await settle(() => unwrap(client.GET('/g2/apis'))) };
}
