import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSections } from '@/lib/nav';

/**
 * Every signed-in page must call `requireUser()` — or `requirePermission()`,
 * which calls it — itself (ADR-0004). The (app)
 * layout checks too, but layouts are not re-rendered on client navigations, so
 * a page without its own check would keep rendering for a user disabled
 * mid-session. Route handlers under this group would need `withUser`.
 */

const GROUP = import.meta.dirname;

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

describe('(app) pages', () => {
  const found = pages(GROUP);

  it('exist', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found.map((path) => [relative(GROUP, path), path]))(
    '%s calls requireUser() or requirePermission()',
    (_, path) => {
      expect(readFileSync(path, 'utf8')).toMatch(/await require(User\(\)|Permission\(')/);
    },
  );

  // The nav hides a section from roles without its permission; that is cosmetic,
  // so the page itself must refuse them (ADR-0005).
  it.each(
    allSections()
      .filter((section) => section.ready && section.permission !== undefined)
      .map((section) => [section.href, section.permission] as const),
  )('%s enforces its nav permission %s', (href, permission) => {
    const source = readFileSync(join(GROUP, href, 'page.tsx'), 'utf8');
    expect(source).toContain(`await requirePermission('${permission}')`);
  });

  // `/apis/new` beside `/apis/[id]` would make an API whose id is "new"
  // unreachable: a static segment always wins. Ids come from the gateway, so
  // any value is possible; a dynamic segment must have no static siblings.
  it('never puts a dynamic segment beside static routes, where they would shadow ids', () => {
    const walk = (dir: string): string[] => {
      const children = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const dynamic = children.some((e) => e.name.startsWith('['));
      const statics = children.filter((e) => !e.name.startsWith('[') && !e.name.startsWith('('));
      const clash = dynamic && statics.length > 0 ? [relative(GROUP, dir) || '.'] : [];
      return [...clash, ...children.flatMap((e) => walk(join(dir, e.name)))];
    };
    expect(walk(GROUP)).toEqual([]);
  });

  it('has no route handlers (they would bypass the page check)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.startsWith('route.')
            ? [join(dir, entry.name)]
            : [],
      );
    expect(walk(GROUP)).toEqual([]);
  });
});
