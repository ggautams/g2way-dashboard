import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The generated contract is what the rest of the app types itself against, so a
// truncated or stale-shaped sync should fail here rather than 200 files later.
describe('g2way contract', () => {
  const root = resolve(__dirname, '../..');
  const spec = JSON.parse(readFileSync(resolve(root, 'contracts/openapi.json'), 'utf8'));

  it('describes the admin surface the dashboard depends on', () => {
    for (const path of [
      '/g2/apis',
      '/g2/apis/{id}',
      '/g2/policies',
      '/g2/keys',
      '/g2/reload',
      '/g2/node',
      '/g2/stats',
    ]) {
      expect(Object.keys(spec.paths)).toContain(path);
    }
  });

  it('authenticates with the admin secret header', () => {
    expect(spec.components.securitySchemes.admin_secret.name).toBe('X-G2-Authorization');
  });

  it('carries the core domain schemas', () => {
    for (const schema of ['ApiDefinition', 'KeySession', 'Policy']) {
      expect(Object.keys(spec.components.schemas)).toContain(schema);
    }
  });

  it('generates types with documentation carried over from the gateway', () => {
    const types = readFileSync(resolve(root, 'contracts/g2way.d.ts'), 'utf8');
    expect(types).toContain('ApiDefinition: {');
    // utoipa passes the Rust rustdoc through as schema descriptions; that is
    // most of the reason reading the generated types beats reading the source.
    expect(types).toContain('@description');
  });
});
