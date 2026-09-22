import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The BFF holds the gateway's admin secret: it must refuse anyone not signed in.
// `withUser` itself is tested in src/lib/auth/api.test.ts; this pins the wiring.
describe('BFF route', () => {
  it('wraps every method in withUser', () => {
    const source = readFileSync(join(import.meta.dirname, '[...path]', 'route.ts'), 'utf8');
    expect(source).toMatch(/const handle = withUser\(/);
    for (const method of source.matchAll(/export const (\w+) = (\w+);/g)) {
      expect(method[2], method[1]).toBe('handle');
    }
  });

  // The proxy enforces each operation's permission against this role (ADR-0005)
  // and audits writes as this user (ADR-0006).
  it('hands the proxy the signed-in user as the actor', () => {
    const source = readFileSync(join(import.meta.dirname, '[...path]', 'route.ts'), 'utf8');
    expect(source).toMatch(
      /proxyToGateway\(request, path, \{ id: user\.id, email: user\.email, role: user\.role \}\)/,
    );
  });

  // The one BFF route that is not the proxy: key rotation (ADR-0009). Same guard,
  // same actor, and only POST.
  it('guards the rotate route the same way', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'keys', '[hash]', 'rotate', 'route.ts'),
      'utf8',
    );
    expect(source).toMatch(/const handle = withUser\(/);
    expect(source).toMatch(
      /rotateKey\(request, hash, \{ id: user\.id, email: user\.email, role: user\.role \}\)/,
    );
    expect([...source.matchAll(/export const (\w+) = (\w+);/g)].map((m) => [m[1], m[2]])).toEqual([
      ['POST', 'handle'],
    ]);
  });
});
