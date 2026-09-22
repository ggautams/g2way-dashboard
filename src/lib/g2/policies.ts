import 'server-only';

import type { Policy } from '@/lib/policies/list';
import { unwrap } from './client';
import { resolveEnvironment } from './environments';
import { settle, type Outcome } from './gateway-status';
import { gatewayClient, type GatewayClientDeps } from './server-client';

/**
 * Policies as the gateway stores them (`GET /g2/policies`, org-scoped by the
 * server client). Storage, not what keys resolve: a policy written since the
 * last reload is listed here before keys see it (`docs/g2way-map.md`).
 */

export type PolicyList = { environment: string; policies: Outcome<Policy[]> };

/**
 * Lists environment `environmentId`'s policies. Registry errors are thrown;
 * gateway and network failures are settled so the page can quote them.
 */
export async function loadPolicies(
  environmentId?: string,
  deps: GatewayClientDeps = {},
): Promise<PolicyList> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return { environment: id, policies: await settle(() => unwrap(client.GET('/g2/policies'))) };
}

export type PolicyItem = { environment: string; policy: Outcome<Policy> };

/** One policy by id (`GET /g2/policies/{id}`); a 404 settles with `status: 404`. */
export async function loadPolicy(
  environmentId: string | undefined,
  policyId: string,
  deps: GatewayClientDeps = {},
): Promise<PolicyItem> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return {
    environment: id,
    policy: await settle(() =>
      unwrap(client.GET('/g2/policies/{id}', { params: { path: { id: policyId } } })),
    ),
  };
}
