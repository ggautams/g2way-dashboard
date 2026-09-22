import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapt } from '../../../scripts/shadcn-tokens.mjs';

// shadcn's `accent`/`muted` mean backgrounds; ours mean the brand colour and
// secondary text. scripts/shadcn-tokens.mjs rewrites them; this keeps it done.
const COLLIDING = /\b(?:bg-accent|text-accent-foreground|bg-muted|text-muted-foreground)\b/;

describe('shadcn/ui components use this project’s tokens', () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((file) => file.endsWith('.tsx'));

  it.each(files)('%s has no colliding shadcn token', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    expect(source.split('\n').filter((line) => COLLIDING.test(line))).toEqual([]);
  });

  it('the rewrite maps each colliding class, muted-foreground before muted', () => {
    expect(
      adapt('hover:bg-accent hover:text-accent-foreground bg-muted/50 text-muted-foreground'),
    ).toBe('hover:bg-subtle hover:text-foreground bg-subtle/50 text-muted');
  });
});
