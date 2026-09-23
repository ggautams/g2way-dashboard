import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The inspector's poll reads individual requests (ADR-0014): it must refuse
// anyone not signed in (`withUser`) and check the role itself, and it only reads.
describe('live requests route', () => {
  const source = readFileSync(join(import.meta.dirname, 'live', 'route.ts'), 'utf8');

  it('wraps GET, and only GET, in withUser', () => {
    expect(source).toMatch(/const handle = withUser\(/);
    expect([...source.matchAll(/export const (\w+) = (\w+);/g)].map((m) => [m[1], m[2]])).toEqual([
      ['GET', 'handle'],
    ]);
  });

  it('hands the signed-in user to the handler, which checks analytics:inspect', () => {
    expect(source).toMatch(/liveRequestsResponse\(request, user\)/);
    const handler = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'lib', 'analytics', 'live.ts'),
      'utf8',
    );
    expect(handler).toMatch(/if \(!can\(user\.role, 'analytics:inspect'\)\)/);
  });
});
