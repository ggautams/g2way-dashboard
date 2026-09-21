import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { can } from '@/lib/auth/rbac';
import { OPERATION_PERMISSIONS, operationPermission } from './operation-permissions';
import { compileEndpoints } from './proxy';

// Every operation the BFF forwards: the same spec-derived set the proxy compiles.
const OPERATIONS = compileEndpoints(spec.paths).flatMap((endpoint) =>
  [...endpoint.methods].map((method) => `${method} ${endpoint.path}`),
);

describe('OPERATION_PERMISSIONS', () => {
  it('covers a non-trivial spec', () => {
    expect(OPERATIONS.length).toBeGreaterThan(10);
  });

  // A sync:g2way that adds an endpoint lands here: decide which permission it needs.
  it.each(OPERATIONS)('maps %s to a permission', (operation) => {
    const [method, path] = operation.split(' ');
    expect(
      operationPermission(method, path),
      `${operation} has no entry in OPERATION_PERMISSIONS — the BFF refuses it until it does`,
    ).toBeDefined();
  });

  it('has no entries for operations the spec no longer has', () => {
    expect(Object.keys(OPERATION_PERMISSIONS).filter((key) => !OPERATIONS.includes(key))).toEqual(
      [],
    );
  });

  it('never grants a write to a viewer, and nothing to a portal-dev', () => {
    for (const operation of OPERATIONS) {
      const [method, path] = operation.split(' ');
      const permission = operationPermission(method, path)!;
      if (method !== 'GET') expect(can('viewer', permission), operation).toBe(false);
      expect(can('portal-dev', permission), operation).toBe(false);
      expect(can('owner', permission), operation).toBe(true);
    }
  });

  it('is case-insensitive on the method and does not match inherited keys', () => {
    expect(operationPermission('get', '/g2/apis')).toBe('apis:read');
    expect(operationPermission('GET', 'constructor')).toBeUndefined();
    expect(operationPermission('GET', '/metrics')).toBeUndefined();
  });
});
