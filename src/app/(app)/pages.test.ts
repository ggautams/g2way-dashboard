import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every signed-in page must call `requireUser()` itself (ADR-0004). The (app)
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
    '%s calls requireUser()',
    (_, path) => {
      expect(readFileSync(path, 'utf8')).toMatch(/await requireUser\(\)/);
    },
  );

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
