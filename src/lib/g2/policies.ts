import 'server-only';

import type { Role } from '@/lib/auth/rbac';
import type { Policy } from '@/lib/policies/list';
import { redactFor } from '@/lib/secrets/redact';
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

/**
 * One policy by id (`GET /g2/policies/{id}`), as `role` may see it: secrets
 * masked without `policies:write` (ADR-0010). A 404 settles with `status: 404`.
 */
export async function loadPolicy(
  environmentId: string | undefined,
  policyId: string,
  role: Role,
  deps: GatewayClientDeps = {},
): Promise<PolicyItem> {
  const { id } = resolveEnvironment(environmentId, deps.registry);
  const client = gatewayClient(id, deps);
  return {
    environment: id,
    policy: await settle(async () =>
      redactFor(
        role,
        'policy',
        await unwrap(client.GET('/g2/policies/{id}', { params: { path: { id: policyId } } })),
      ),
    ),
  };
}
