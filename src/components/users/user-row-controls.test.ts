import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No component renderer in this repo, so this guards the fix at the source:
// with one action state per form, a success on one form left the other's
// error on screen (ROADMAP M2 hardening). The row's forms must share one.
describe('UserRowControls', () => {
  it('drives every form in a row from a single action state', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'user-row-controls.tsx'), 'utf8');
    expect(source.match(/useActionState\(/g)).toHaveLength(1);
    expect(source.match(/<form action=\{formAction\}/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
