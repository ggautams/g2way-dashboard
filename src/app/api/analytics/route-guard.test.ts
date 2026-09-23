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

// The CSV export reads the same view as /analytics (ADR-0013 §8): signed-in
// users only, `gateway:read` checked by the handler, and only GET.
describe('traffic export route', () => {
  const source = readFileSync(join(import.meta.dirname, 'export', 'route.ts'), 'utf8');

  it('wraps GET, and only GET, in withUser', () => {
    expect(source).toMatch(/const handle = withUser\(/);
    expect([...source.matchAll(/export const (\w+) = (\w+);/g)].map((m) => [m[1], m[2]])).toEqual([
      ['GET', 'handle'],
    ]);
  });

  it('hands the signed-in user to the handler, which checks gateway:read and keys:read', () => {
    expect(source).toMatch(/trafficExportResponse\(request, user\)/);
    const handler = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'lib', 'analytics', 'export.ts'),
      'utf8',
    );
    expect(handler).toMatch(/if \(!can\(user\.role, 'gateway:read'\)\)/);
    expect(handler).toMatch(/keys: can\(user\.role, 'keys:read'\)/);
    // Never the live tail: it is a sample (ADR-0014).
    expect(handler).not.toMatch(/queryTail|analytics_tail|analyticsTail/);
  });
});
