import type { Permission } from '@/lib/auth/rbac';

/**
 * The permission each gateway admin operation requires through the BFF,
 * keyed `"<METHOD> <spec path template>"` exactly as `contracts/openapi.json`
 * spells it. Default deny: an operation missing here is refused by the proxy,
 * and `operation-permissions.test.ts` fails for every operation in the spec
 * without an entry — so a `sync:g2way` that adds an endpoint forces a decision
 * here before the gate goes green (ADR-0005).
 */
export const OPERATION_PERMISSIONS: Readonly<Record<string, Permission>> = {
  'GET /g2/health': 'gateway:read',
  'GET /g2/version': 'gateway:read',
  'GET /g2/node': 'gateway:read',
  'GET /g2/stats': 'gateway:read',

  'GET /g2/apis': 'apis:read',
  'GET /g2/apis/{id}': 'apis:read',
  'POST /g2/apis': 'apis:write',
  'PUT /g2/apis/{id}': 'apis:write',
  'DELETE /g2/apis/{id}': 'apis:write',

  'GET /g2/policies': 'policies:read',
  'GET /g2/policies/{id}': 'policies:read',
  'POST /g2/policies': 'policies:write',
  'PUT /g2/policies/{id}': 'policies:write',
  'DELETE /g2/policies/{id}': 'policies:write',

  'GET /g2/keys': 'keys:read',
  'GET /g2/keys/{key}': 'keys:read',
  'POST /g2/keys': 'keys:write',
  'PUT /g2/keys/{key}': 'keys:write',
  'DELETE /g2/keys/{key}': 'keys:write',

  'POST /g2/reload': 'gateway:reload',
  'POST /g2/graphql/sync': 'graphql:sync',
};

/** The permission `method` on `pathTemplate` requires, or `undefined` if unmapped (deny). */
export function operationPermission(method: string, pathTemplate: string): Permission | undefined {
  const key = `${method.toUpperCase()} ${pathTemplate}`;
  return Object.hasOwn(OPERATION_PERMISSIONS, key) ? OPERATION_PERMISSIONS[key] : undefined;
}
