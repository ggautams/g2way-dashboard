#!/usr/bin/env node
// Adapts shadcn/ui components to this project's theme tokens (ADR-0001 §5).
//
// Most shadcn tokens map onto ours as aliases in `src/app/globals.css`
// (`primary` is our `accent`, `destructive` our `danger`, `input` our `border`
// and so on). Two names collide with a different meaning, so no alias can fix
// them, and this rewrites them in `src/components/ui/`:
//
//   shadcn `accent`  = a hover/selected background → our `subtle` (ours is the brand colour)
//   shadcn `muted`   = a quiet background           → our `subtle`
//   shadcn `muted-foreground` = secondary text       → our `muted`
//
// `npm run ui:add -- dialog tabs` runs the pinned `shadcn add` and then this;
// run it bare after any other change there. `src/components/ui/tokens.test.ts`
// fails if a colliding class slips through.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** [pattern, replacement], applied in order. `muted-foreground` goes before `muted`. */
export const REWRITES = [
  [/\btext-muted-foreground\b/g, 'text-muted'],
  [/\bbg-muted\b/g, 'bg-subtle'],
  [/\btext-accent-foreground\b/g, 'text-foreground'],
  [/\bbg-accent\b/g, 'bg-subtle'],
];

export function adapt(source) {
  return REWRITES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    source,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const [flag, ...components] = process.argv.slice(2);
  const adding = flag === '--add';
  if (adding && components.length === 0) {
    console.error('usage: npm run ui:add -- <component> [...]');
    process.exit(2);
  }
  if (adding) run('shadcn', ['add', '--yes', ...components]);
  const dir = fileURLToPath(new URL('../src/components/ui/', import.meta.url));
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.tsx'))) {
    const path = join(dir, name);
    const before = readFileSync(path, 'utf8');
    const after = adapt(before);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`shadcn-tokens: adapted ${name}`);
    }
  }
  if (adding) run('prettier', ['--write', dir]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
