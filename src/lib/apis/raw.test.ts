import { describe, expect, it } from 'vitest';
import type { ApiDefinition } from './list';
import { parseRaw, schemaValidator, serialize } from '@/lib/designer/raw';
import { isDraftShape } from './raw';
import { apiDefinitionSchema } from './schema';

const api: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://orders:80',
  active: false,
  auth: { mode: 'jwt', signing_method: 'hs256', secret: 'shh' },
  target_list: ['http://a', 'http://b'],
};

describe('serialize / parseRaw', () => {
  it.each(['json', 'yaml'] as const)('round-trips a definition through %s', (format) => {
    const parsed = parseRaw(serialize(api, format), format);
    expect(parsed).toEqual({ ok: true, value: api });
  });

  it('reports the parser’s own message for broken text', () => {
    expect(parseRaw('{"api_id": ', 'json')).toMatchObject({ ok: false, error: expect.any(String) });
    expect(parseRaw('a: [unclosed', 'yaml')).toMatchObject({ ok: false });
  });
});

describe('isDraftShape', () => {
  it('needs an object with the four required fields as strings', () => {
    expect(isDraftShape(api)).toBe(true);
    expect(isDraftShape({ ...api, name: 3 })).toBe(false);
    expect(isDraftShape([api])).toBe(false);
    expect(isDraftShape(null)).toBe(false);
  });
});

describe('the ApiDefinition schema', () => {
  const schema = apiDefinitionSchema();
  const validate = schemaValidator(schema);

  it('carries the definition and only the schemas it references', () => {
    const names = Object.keys((schema.components as { schemas: object }).schemas);
    expect(names).toContain('ApiDefinition');
    expect(names).toContain('AuthConfig');
    expect(names).not.toContain('KeySession');
  });

  it('accepts a sound definition', () => {
    expect(validate(api)).toEqual([]);
  });

  it('names what is wrong, by path', () => {
    const nameless: Partial<ApiDefinition> = { ...api };
    delete nameless.name;
    expect(validate(nameless)).toContainEqual({ path: '(top level)', message: 'missing "name"' });
    expect(validate({ ...api, upstream_retries: 'three' })).toContainEqual({
      path: '/upstream_retries',
      message: expect.stringMatching(/integer/),
    });
    expect(validate({ ...api, auth: { mode: 'carrier-pigeon' } }).map((p) => p.path)).toContain(
      '/auth',
    );
  });
});
