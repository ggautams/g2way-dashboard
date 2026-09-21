import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The admin secret must never reach the browser (CLAUDE.md). Every module a
 * `'use client'` file pulls in — transitively — ships in the client bundle, so
 * none of them may be `server-only`. This walks the real import graph of `src/`.
 */

const SRC = resolve(import.meta.dirname, '..');
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Resolves an import specifier to a file in `src/`, or null for packages and non-code. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  if (!base.startsWith(SRC)) return null; // contracts/ etc.: generated types, no secrets
  const candidates = /\.tsx?$/.test(base) ? [base] : EXTENSIONS.map((ext) => base + ext);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;

function imports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
}

/** Import chain from `entry` to a module that imports `server-only`, if any. */
function serverOnlyChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const specifiers = imports(file);
    if (specifiers.includes('server-only')) return chain;
    for (const specifier of specifiers) {
      const next = resolveImport(file, specifier);
      if (!next) continue;
      const found = walk(next, [...chain, relative(SRC, next)]);
      if (found) return found;
    }
    return null;
  };
  return walk(entry, [relative(SRC, entry)]);
}

const clientEntries = sourceFiles(SRC).filter((file) =>
  /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')),
);

describe('client boundary', () => {
  it('finds the client components', () => {
    expect(clientEntries.length).toBeGreaterThan(0);
  });

  it('detects a server-only module when one is reachable', () => {
    expect(serverOnlyChain(join(SRC, 'lib/g2/proxy.ts'))).not.toBeNull();
  });

  it.each(clientEntries.map((file) => [relative(SRC, file), file]))(
    '%s reaches no server-only module',
    (_, file) => {
      expect(serverOnlyChain(file)).toBeNull();
    },
  );
});
