import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A raw key exists once, in `POST /g2/keys`'s answer (or the rotate route's),
 * and may be shown once. These are the modules that ever hold one; none may
 * log it, store it in the browser, or navigate with it. The audit side (no raw
 * key in any row) is tested against a real database in
 * `src/lib/g2/rotate-key.test.ts` and `src/lib/g2/proxy.test.ts`.
 */

const SRC = resolve(import.meta.dirname, '../..');
const HOLDERS = [
  'lib/keys/save.ts',
  'lib/keys/session.ts',
  'lib/g2/rotate-key.ts',
  'components/keys/raw-key-dialog.tsx',
  'components/keys/key-designer.tsx',
  'components/keys/key-actions.tsx',
];

describe('modules that hold a raw key', () => {
  it.each(HOLDERS)('%s neither logs nor stores it', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    expect(source).not.toMatch(
      /\b(localStorage|sessionStorage|indexedDB|document\.cookie|console\.(log|info|debug|warn))\b/,
    );
    // console.error only for audit failures, which never carry the key.
    const errors = source.match(/console\.error\(/g) ?? [];
    const audited = source.match(/console\.error\(\s*`\[audit\]/g) ?? [];
    expect(audited.length).toBe(errors.length);
  });

  it.each(HOLDERS)('%s never puts it in a URL', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    // Navigations and links built from `.key` (not `.key_hash`, not `.hash`).
    for (const match of source.matchAll(/router\.(replace|push)\(([^;]*)\);/g)) {
      expect(match[2]).not.toMatch(/\.key\b|\bkey\b(?!_)/);
    }
    expect(source).not.toMatch(/href=\{[^}]*\.key\b/);
  });

  it('drops the minted key when its dialog closes', () => {
    for (const file of ['components/keys/key-designer.tsx', 'components/keys/key-actions.tsx']) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const done = source.slice(source.indexOf('const done = () => {'));
      expect(done.slice(0, done.indexOf('};'))).toContain('setMinted(null)');
    }
  });
});
