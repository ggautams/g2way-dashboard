import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSections, isActive } from './nav';

const APP_DIR = join(import.meta.dirname, '..', 'app');

describe('NAV', () => {
  it('has unique hrefs', () => {
    const hrefs = allSections().map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('marks a section ready exactly when its page exists', () => {
    for (const section of allSections()) {
      const page = join(APP_DIR, section.href, 'page.tsx');
      expect(existsSync(page), `${section.href} ready=${section.ready}`).toBe(section.ready);
    }
  });
});

describe('isActive', () => {
  it('matches a section and its children, and / only exactly', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/apis')).toBe(false);
    expect(isActive('/apis', '/apis')).toBe(true);
    expect(isActive('/apis', '/apis/foo')).toBe(true);
    expect(isActive('/apis', '/apis-old')).toBe(false);
  });
});
