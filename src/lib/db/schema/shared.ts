/**
 * Dialect-neutral pieces of the dashboard schema. `sqlite.ts` and `pg.ts` each
 * declare the same tables in their own dialect (Drizzle table builders are
 * dialect-typed); anything both need to agree on lives here, and
 * `schema.test.ts` fails if the two drift apart. See ADR-0003.
 */

/** Dashboard roles. Stored as text, so changing this list needs no migration. */
export const ROLES = ['owner', 'admin', 'editor', 'viewer', 'portal-dev'] as const;
export type Role = (typeof ROLES)[number];

/** Stand-in type for audit before/after snapshots: any JSON value. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
