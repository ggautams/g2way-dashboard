import 'server-only';

import type { ApiDefinition } from '@/lib/apis/list';
import type { Role } from '@/lib/auth/rbac';
import { apiChoice, type ApiChoices } from '@/lib/designer/access';
import { unwrap } from './client';
import { resolveEnvironment } from './environments';
import { settle, type Outcome } from './gateway-status';
import { gatewayClient, type GatewayClientDeps } from './server-client';
import { redactFor } from '@/lib/secrets/redact';

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

export type ApiItem = { environment: string; api: Outcome<ApiDefinition> };

/**
 * One definition by id (`GET /g2/apis/{id}`), as `role` may see it: secrets
 * masked without `apis:write` (ADR-0010). A 404 settles with `status: 404`.
 * This is the loader for a page that hands the definition to the browser.
 */
export async function loadApi(
  environmentId: string | undefined,
  apiId: string,
  role: Role,
  deps: GatewayClientDeps = {},
): Promise<ApiItem> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return {
    environment: id,
    api: await settle(async () =>
      redactFor(
        role,
        'api',
        await unwrap(client.GET('/g2/apis/{id}', { params: { path: { id: apiId } } })),
      ),
    ),
  };
}

/**
 * The environment's APIs as the access matrix offers them: id, name and
 * whether GraphQL is configured, never the definitions themselves, which stay
 * on the server. A gateway failure is quoted, with its status.
 */
export async function loadApiChoices(
  environmentId: string | undefined,
  deps: GatewayClientDeps = {},
): Promise<ApiChoices> {
  const { apis } = await loadApis(environmentId, deps);
  if (!apis.ok) {
    return {
      ok: false,
      error: apis.status === undefined ? apis.error : `${apis.error} (HTTP ${apis.status})`,
    };
  }
  return { ok: true, value: apis.value.map(apiChoice) };
}
