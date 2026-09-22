/**
 * The dashboard's sections, in sidebar order. One registry feeds the sidebar and
 * the command palette. A section is `ready` once its page exists; planned
 * sections stay visible (disabled, tagged with their milestone) so the shell
 * shows where the product is going, and the command palette only offers ready
 * ones. `nav.test.ts` fails if a ready section has no page.
 *
 * A section's `permission` hides it from roles that lack it. That is cosmetic:
 * the page enforces it with `requirePermission()` (`(app)/pages.test.ts` checks
 * the two agree), and the BFF enforces each gateway operation on its own.
 */

import type { Permission } from '@/lib/auth/rbac';

export type NavSection = {
  /** Route path. Also the page directory under `src/app/`. */
  href: string;
  label: string;
  /** Short description, shown in the command palette. */
  description: string;
  /** Extra words the command palette matches on. */
  keywords?: readonly string[];
  /** The `ROADMAP.md` milestone that builds it. */
  milestone: string;
  ready: boolean;
  /** Needed to see the section; its page must `requirePermission()` it. Unset: every role. */
  permission?: Permission;
};

export type NavGroup = { label: string; sections: readonly NavSection[] };

export const NAV: readonly NavGroup[] = [
  {
    label: 'Gateway',
    sections: [
      {
        href: '/',
        label: 'Overview',
        description: 'Configured gateways and dashboard status',
        keywords: ['home', 'dashboard'],
        milestone: 'M1',
        ready: true,
      },
      {
        href: '/gateway',
        label: 'Gateway',
        description: 'Routes, target health, circuit breakers',
        keywords: ['node', 'health', 'version', 'routes'],
        milestone: 'M1',
        ready: true,
        permission: 'gateway:read',
      },
    ],
  },
  {
    label: 'Manage',
    sections: [
      {
        href: '/apis',
        label: 'APIs',
        description: 'API definitions',
        keywords: ['definitions', 'designer'],
        milestone: 'M3',
        ready: true,
        permission: 'apis:read',
      },
      {
        href: '/policies',
        label: 'Policies',
        description: 'Access policies',
        keywords: ['rate limit', 'quota', 'tiers'],
        milestone: 'M4',
        ready: true,
        permission: 'policies:read',
      },
      {
        href: '/keys',
        label: 'Keys',
        description: 'API keys and quotas',
        keywords: ['tokens', 'credentials'],
        milestone: 'M4',
        ready: true,
        permission: 'keys:read',
      },
      {
        href: '/graphql',
        label: 'GraphQL',
        description: 'Schemas, sync and federation',
        milestone: 'M8',
        ready: false,
        permission: 'apis:read',
      },
      {
        href: '/plugins',
        label: 'Plugins',
        description: 'WASM plugins',
        milestone: 'M9',
        ready: false,
        permission: 'apis:read',
      },
    ],
  },
  {
    label: 'Observe',
    sections: [
      {
        href: '/analytics',
        label: 'Analytics',
        description: 'Traffic, errors and latency',
        keywords: ['metrics', 'traffic'],
        milestone: 'M6',
        ready: false,
        permission: 'gateway:read',
      },
    ],
  },
  {
    label: 'Admin',
    sections: [
      {
        href: '/users',
        label: 'Users & roles',
        description: 'Dashboard accounts and RBAC',
        keywords: ['rbac', 'accounts'],
        milestone: 'M2',
        ready: true,
        permission: 'users:manage',
      },
      {
        href: '/audit',
        label: 'Audit log',
        description: 'Who changed what',
        keywords: ['history'],
        milestone: 'M2',
        ready: true,
        permission: 'audit:read',
      },
    ],
  },
];

export function allSections(): NavSection[] {
  return NAV.flatMap((group) => group.sections);
}

/** Whether `pathname` is inside `href` (`/` only matches itself). */
export function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Whether a role with `permissions` may see `section`. */
export function sectionAllowed(section: NavSection, permissions: readonly Permission[]): boolean {
  return section.permission === undefined || permissions.includes(section.permission);
}

/** The registry as a role with `permissions` sees it: forbidden sections and empty groups dropped. */
export function navFor(permissions: readonly Permission[]): NavGroup[] {
  return NAV.map((group) => ({
    label: group.label,
    sections: group.sections.filter((section) => sectionAllowed(section, permissions)),
  })).filter((group) => group.sections.length > 0);
}
