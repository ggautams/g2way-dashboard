import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  isRole,
  userChangeDenial,
  type Role,
} from './rbac';

describe('ROLE_PERMISSIONS', () => {
  // The matrix ADR-0005 records. Changing it is a decision: update the ADR too.
  it('matches the recorded matrix', () => {
    const matrix = Object.fromEntries(
      ROLES.map((role) => [role, PERMISSIONS.filter((p) => can(role, p))]),
    );
    expect(matrix).toEqual({
      owner: [...PERMISSIONS],
      admin: [...PERMISSIONS],
      editor: [
        'gateway:read',
        'apis:read',
        'apis:write',
        'apis:test',
        'policies:read',
        'policies:write',
        'keys:read',
        'gateway:reload',
        'graphql:sync',
        'analytics:inspect',
        'analytics:share',
      ],
      viewer: ['gateway:read', 'apis:read', 'policies:read', 'keys:read'],
      'portal-dev': [],
    });
  });

  it('is cumulative: each role holds everything the one below it does', () => {
    const ladder: Role[] = ['viewer', 'editor', 'admin', 'owner'];
    for (let i = 1; i < ladder.length; i++) {
      for (const permission of ROLE_PERMISSIONS[ladder[i - 1]]) {
        expect(can(ladder[i], permission), `${ladder[i]} ${permission}`).toBe(true);
      }
    }
  });

  it('holds only known permissions, without duplicates', () => {
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size).toBe(granted.length);
      for (const permission of granted) expect(PERMISSIONS).toContain(permission);
    }
  });
});

describe('isRole', () => {
  it('accepts exactly the stored roles', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const value of ['Owner', 'root', '', null, 1]) expect(isRole(value)).toBe(false);
  });
});

describe('userChangeDenial', () => {
  const as = (role: Role, id = `${role}-actor`) => ({ id, role });
  const target = (role: Role) => ({ id: `${role}-target`, role });

  it('lets an owner grant and modify every role, owners included', () => {
    for (const from of ROLES) {
      for (const to of ROLES) expect(userChangeDenial(as('owner'), target(from), to)).toBeNull();
    }
    for (const role of ROLES) expect(userChangeDenial(as('owner'), null, role)).toBeNull();
  });

  it('lets an admin work strictly below admin', () => {
    expect(ASSIGNABLE_ROLES.admin).toEqual(['editor', 'viewer', 'portal-dev']);
    for (const role of ASSIGNABLE_ROLES.admin) {
      expect(userChangeDenial(as('admin'), null, role)).toBeNull();
    }
    expect(userChangeDenial(as('admin'), null, 'admin')).toMatch(/cannot grant the admin role/);
    expect(userChangeDenial(as('admin'), null, 'owner')).toMatch(/cannot grant the owner role/);
    expect(userChangeDenial(as('admin'), target('owner'), 'owner')).toMatch(
      /cannot modify an account with the owner role/,
    );
    expect(userChangeDenial(as('admin'), target('admin'), 'viewer')).toMatch(/admin role/);
    expect(userChangeDenial(as('admin'), target('viewer'), 'admin')).toMatch(/cannot grant/);
    expect(userChangeDenial(as('admin'), target('viewer'), 'editor')).toBeNull();
  });

  it('refuses every role without users:manage', () => {
    for (const role of ['editor', 'viewer', 'portal-dev'] as const) {
      expect(userChangeDenial(as(role), target('viewer'), 'viewer')).toMatch(/users:manage/);
      expect(userChangeDenial(as(role), null, 'viewer')).toMatch(/users:manage/);
    }
  });

  it('refuses changes to your own account, so nobody escalates themselves', () => {
    for (const role of ['owner', 'admin'] as const) {
      const self = as(role, 'me');
      expect(userChangeDenial(self, { id: 'me', role }, 'owner')).toMatch(/your own account/);
      expect(userChangeDenial(self, { id: 'me', role }, role)).toMatch(/your own account/);
    }
  });
});
