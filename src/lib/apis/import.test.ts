import { describe, expect, it } from 'vitest';
import { importOpenApi } from './import';

const petstore3 = `
openapi: 3.0.3
info:
  title: Swagger Petstore
  version: 1.0.0
servers:
  - url: https://{region}.petstore.example/v1
    variables:
      region:
        default: eu
  - url: https://backup.petstore.example/v1
security:
  - api_key: []
components:
  securitySchemes:
    api_key:
      type: apiKey
      in: header
      name: X-Api-Key
paths:
  /pets: {}
  /pets/{id}: {}
`;

const swagger2 = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy Orders', version: '1' },
  host: 'orders.internal:8080',
  basePath: '/api',
  schemes: ['http', 'https'],
  securityDefinitions: { basic: { type: 'basic' } },
  paths: { '/orders': {} },
});

describe('importOpenApi', () => {
  it('maps an OpenAPI 3 document: name, id, listen path, first server, header key', () => {
    const result = importOpenApi(petstore3);
    expect(result).toMatchObject({
      ok: true,
      draft: {
        api_id: 'swagger-petstore',
        name: 'Swagger Petstore',
        listen_path: '/swagger-petstore/',
        target_url: 'https://eu.petstore.example/v1',
        active: true,
        auth: { mode: 'auth_token', header: 'X-Api-Key' },
      },
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.notes.join('\n')).toMatch(/first of 2 servers/);
    expect(result.notes.join('\n')).toMatch(/2 paths/);
  });

  it('maps Swagger 2: https preferred, host and basePath, basic auth', () => {
    expect(importOpenApi(swagger2)).toMatchObject({
      ok: true,
      draft: {
        name: 'Legacy Orders',
        target_url: 'https://orders.internal:8080/api',
        auth: { mode: 'basic_auth' },
      },
    });
  });

  it('never makes an API keyless: no security keeps g2way’s token auth, with a note', () => {
    const result = importOpenApi(
      JSON.stringify({ openapi: '3.1.0', info: { title: 'Open' }, servers: [{ url: 'http://x' }] }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.draft).not.toHaveProperty('auth');
    expect(result.notes.join('\n')).toMatch(/keeps g2way’s default token auth/);
  });

  it('maps bearer to JWT and OpenID Connect to OIDC with its issuer', () => {
    const doc = (scheme: object) =>
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T' },
        servers: [{ url: 'http://t' }],
        components: { securitySchemes: { s: scheme } },
      });
    expect(importOpenApi(doc({ type: 'http', scheme: 'bearer' }))).toMatchObject({
      draft: { auth: { mode: 'jwt', signing_method: 'rs256' } },
    });
    expect(
      importOpenApi(
        doc({
          type: 'openIdConnect',
          openIdConnectUrl: 'https://id.example/realms/x/.well-known/openid-configuration',
        }),
      ),
    ).toMatchObject({
      draft: { auth: { mode: 'oidc', issuer_url: 'https://id.example/realms/x', audiences: [] } },
    });
  });

  it('leaves a relative or missing server for the user, and explains', () => {
    const result = importOpenApi('openapi: 3.0.0\ninfo: {title: Rel}\nservers: [{url: /v1}]');
    if (!result.ok) throw new Error('expected ok');
    expect(result.draft.target_url).toBe('');
    expect(result.notes.join('\n')).toMatch(/not absolute/);
  });

  it('refuses what is not an OpenAPI or Swagger document, saying why', () => {
    expect(importOpenApi('')).toMatchObject({ ok: false, error: /Paste or choose/ });
    expect(importOpenApi('{"openapi": ')).toMatchObject({ ok: false, error: /Not valid JSON/ });
    expect(importOpenApi('name: not an api')).toMatchObject({ ok: false, error: /OpenAPI 3/ });
  });
});
